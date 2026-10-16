/**
 * 辅助模型直连请求的思考参数取值规则。
 *
 * 目标是「使用该模型允许的最少思考」:
 * - 用哪一档由模型目录决定(声明档位里的最低档);
 * - 能不能关掉思考由请求协议决定(Messages / Chat 先试关掉,Responses 没有关掉的写法);
 * - 各厂商写法差异交给 model-compat(调用方在组装好 Chat / Responses 请求体后归一一次);
 * - 只有参数类错误(400 / 422,以及 Cindy AI 原生接口的 404)才沿着计划往下退,
 *   成功的那一步按「供应商 + 模型 + 请求格式」记在内存里,下次直接从它开始。
 *
 * 这里只看状态码,不解析报错文案;也只记成功,不记失败。
 */
import {
  profileModelListed,
  profileModelValue,
  resolveProviderCompatibilityProfile,
  type CompatibilityHarness,
} from '@cindy/model-compat';
import { effortRank, type CatalogModel, type Effort } from '@cindy/model-providers';

export type UtilityProviderWire = 'chat-completions' | 'anthropic-messages' | 'responses';

/** 一次请求要带的思考参数:关掉 / 某一档 / 完全不带。 */
export type UtilityReasoningRung =
  | { kind: 'off' }
  | { kind: 'effort'; effort: string }
  | { kind: 'omit' };

/**
 * 目录对该模型思考档位的说法:
 * - declared:声明了档位(按强弱升序);
 * - empty:明确声明没有档位(或厂商档案标为不思考);
 * - unknown:没有任何来源声明过。
 */
export type UtilityReasoningDeclaration =
  | { kind: 'declared'; efforts: readonly string[] }
  | { kind: 'empty' }
  | { kind: 'unknown' };

export type UtilityRequestStep = {
  wire: UtilityProviderWire;
  rung: UtilityReasoningRung;
  /** 去掉所有可选字段的兜底请求体(仅自定义供应商沿用的旧行为)。 */
  minimalBody?: boolean;
  /** Cindy AI 原生接口:404 视为「该格式不可用」,直接退回 Chat。 */
  gatewayNative?: boolean;
};

/** 写死的档位兜底只用于目录没声明的模型,与改动前 Responses 的取值一致。 */
const UNKNOWN_MODEL_EFFORT = 'low';

/** 每次辅助请求因参数类错误而发出的请求总数上限(不含 #6098 的预算重试)。 */
export const MAX_REASONING_REQUESTS = 4;

/**
 * Cindy AI 网关的模型档位由网关下发;下发里缺了 efforts 时目录会落成 `[]`,
 * 与「明确声明为空」不可区分。网关的原始声明保留在 discoveredMetadata 里,
 * 据此把「没下发」识别为未声明,而不是当成「这个模型不思考」。
 */
export function utilityReasoningDeclaration(
  providerId: string,
  agentKind: string,
  model: Pick<CatalogModel, 'efforts' | 'effortsUnknown' | 'discoveredMetadata' | 'reasoning'> | undefined,
): UtilityReasoningDeclaration {
  if (!model || model.effortsUnknown || !Array.isArray(model.efforts)) return { kind: 'unknown' };
  if (model.efforts.length === 0) {
    if (providerId === 'xd') {
      return Array.isArray(model.discoveredMetadata?.efforts) ? { kind: 'empty' } : { kind: 'unknown' };
    }
    // 自定义 Pi 模型从不打「未声明」标记,`[]` 只是 Pi 运行时的占位(见
    // model-providers user-provider.ts);只有显式 reasoning:false 才算声明为空。
    if (agentKind === 'pi' && model.reasoning !== false) return { kind: 'unknown' };
    return { kind: 'empty' };
  }
  const efforts = [...new Set(model.efforts)].sort(
    (a, b) => effortRank(a as Effort) - effortRank(b as Effort),
  );
  return { kind: 'declared', efforts };
}

/** 厂商档案把该模型标成不思考时,一开始就不带思考参数。只对 Chat / Responses 生效。 */
export function compatMarksNoReasoning(input: {
  wire: UtilityProviderWire;
  harness: CompatibilityHarness;
  upstreamBase: string;
  model: string;
}): boolean {
  if (input.wire === 'anthropic-messages') return false;
  const profile = resolveProviderCompatibilityProfile({
    harness: input.harness,
    protocol: input.wire === 'responses' ? 'openai-responses' : 'openai-chat',
    upstreamBase: input.upstreamBase,
    model: input.model,
  });
  return Boolean(profile && profileModelListed(profile.noReasoningModels, input.model));
}

/**
 * 厂商档案是否给出了「关掉思考」的专门写法(网关对象格式,或档位映射里有 `none`)。
 * 有时 Chat 的「关掉」交给 model-compat 翻译 `reasoning_effort: 'none'`;没有时保持
 * 原来的 `thinking: disabled` + `reasoning_effort: 'minimal'` 且不经档位映射——
 * 否则 `minimal` 会被当成「要一档思考」映射成 low / 思考预算 / enabled。
 */
export function compatHasReasoningOff(input: {
  harness: CompatibilityHarness;
  upstreamBase: string;
  model: string;
}): boolean {
  const profile = resolveProviderCompatibilityProfile({
    harness: input.harness,
    protocol: 'openai-chat',
    upstreamBase: input.upstreamBase,
    model: input.model,
  });
  if (!profile) return false;
  if (profile.reasoningWireFormat === 'gateway-object') return true;
  const wireMap = profileModelValue(profile.modelReasoningEffortMap, input.model) ?? profile.reasoningEffortMap;
  return typeof wireMap === 'object' && wireMap !== null && Object.hasOwn(wireMap, 'none');
}

/** 同一声明在某个请求格式上的退让顺序:关掉(协议支持时)→ 最低档 → 高一档。 */
export function utilityReasoningRungs(
  wire: UtilityProviderWire,
  declaration: UtilityReasoningDeclaration,
): UtilityReasoningRung[] {
  if (declaration.kind === 'empty') return [{ kind: 'omit' }];
  const off: UtilityReasoningRung[] = wire === 'responses' ? [] : [{ kind: 'off' }];
  const efforts = declaration.kind === 'declared'
    ? declaration.efforts.slice(0, 2)
    : [UNKNOWN_MODEL_EFFORT];
  return [...off, ...efforts.map((effort) => ({ kind: 'effort' as const, effort }))];
}

export function utilityReasoningRungKey(rung: UtilityReasoningRung): string {
  return rung.kind === 'effort' ? `effort:${rung.effort}` : rung.kind;
}

export function utilityRequestStepKey(step: UtilityRequestStep): string {
  return `${step.wire}|${utilityReasoningRungKey(step.rung)}${step.minimalBody ? '|minimal' : ''}`;
}

export type UtilityReasoningMode =
  /** 默认:按目录声明逐级退让。 */
  | { kind: 'ladder'; declaration: UtilityReasoningDeclaration }
  /** 调用方显式要求的单一取值(重新打开思考、或指定档位),不做档位退让。 */
  | { kind: 'fixed'; rung: UtilityReasoningRung };

/**
 * 生成一次请求的完整计划。
 *
 * - `chatFallback`:Cindy AI 按模型原生格式发,原生格式出参数 / 格式类错误时退回 Chat,
 *   Chat 从原生格式起步的那一档接着往下退(思考档位照常带上,不会丢)。
 * - `minimalBodyFallback`:自定义供应商沿用的「去掉所有可选参数」兜底;档位模式下
 *   只给目录没声明档位(或声明为空)的模型,声明了档位的绝不退到不带思考参数。
 */
export function buildUtilityRequestPlan(input: {
  wire: UtilityProviderWire;
  mode: UtilityReasoningMode;
  chatFallback?: boolean;
  minimalBodyFallback?: boolean;
}): UtilityRequestStep[] {
  const { wire, mode } = input;
  const withChatFallback = input.chatFallback === true && wire !== 'chat-completions';
  const steps: UtilityRequestStep[] = [];
  if (mode.kind === 'fixed') {
    // Messages 从未表达过调用方指定的档位,保持原样;退回 Chat 时照常带上。
    const nativeRung: UtilityReasoningRung =
      wire === 'anthropic-messages' && mode.rung.kind === 'effort' ? { kind: 'omit' } : mode.rung;
    steps.push({ wire, rung: nativeRung, ...(withChatFallback ? { gatewayNative: true } : {}) });
    if (withChatFallback) steps.push({ wire: 'chat-completions', rung: mode.rung });
  } else {
    const nativeRungs = utilityReasoningRungs(wire, mode.declaration);
    for (const rung of nativeRungs) {
      steps.push({ wire, rung, ...(withChatFallback ? { gatewayNative: true } : {}) });
    }
    if (withChatFallback) {
      const chatRungs = utilityReasoningRungs('chat-completions', mode.declaration);
      const startKey = utilityReasoningRungKey(nativeRungs[0]!);
      const start = Math.max(0, chatRungs.findIndex((rung) => utilityReasoningRungKey(rung) === startKey));
      for (const rung of chatRungs.slice(start)) steps.push({ wire: 'chat-completions', rung });
    }
  }
  const minimalAllowed = mode.kind === 'fixed' || mode.declaration.kind !== 'declared';
  if (input.minimalBodyFallback && minimalAllowed && wire !== 'anthropic-messages') {
    steps.push({ wire, rung: { kind: 'omit' }, minimalBody: true });
  }
  return steps;
}

/**
 * 参数类错误时计划的下一步;返回 null 表示不再退让。
 * 401 / 403 / 429 / 5xx 一律不退让:换写法解决不了鉴权、限流和服务端故障。
 */
export function nextUtilityRequestStep(
  steps: readonly UtilityRequestStep[],
  index: number,
  status: number,
): number | null {
  const step = steps[index];
  if (!step) return null;
  if (status === 404) {
    if (!step.gatewayNative) return null;
    // 原生接口不存在:原生格式的其它档位同样不可用,带着当前档位直接退回 Chat。
    const chat = steps.findIndex((candidate, i) => i > index && candidate.wire === 'chat-completions');
    if (chat < 0) return null;
    const sameRung = steps.findIndex((candidate, i) =>
      i >= chat
      && candidate.wire === 'chat-completions'
      && utilityReasoningRungKey(candidate.rung) === utilityReasoningRungKey(step.rung));
    return sameRung >= 0 ? sameRung : chat;
  }
  if (status !== 400 && status !== 422) return null;
  return index + 1 < steps.length ? index + 1 : null;
}

/** 只记成功的写法,进程内有效;重启后清空。 */
const rememberedSteps = new Map<string, string>();
const REMEMBERED_STEP_LIMIT = 256;

export function utilityReasoningMemoryKey(parts: {
  providerId: string;
  agentKind: string;
  model: string;
  wire: UtilityProviderWire;
  mode: UtilityReasoningMode;
}): string {
  const mode = parts.mode.kind === 'ladder' ? 'ladder' : `fixed:${utilityReasoningRungKey(parts.mode.rung)}`;
  return JSON.stringify([parts.providerId, parts.agentKind, parts.model, parts.wire, mode]);
}

/** 记住的写法若仍在本次计划里,就从它开始;它后来被拒时照常往下退。 */
export function rememberedUtilityStepIndex(
  memoryKey: string | undefined,
  steps: readonly UtilityRequestStep[],
): number {
  if (!memoryKey) return 0;
  const remembered = rememberedSteps.get(memoryKey);
  if (!remembered) return 0;
  return Math.max(0, steps.findIndex((step) => utilityRequestStepKey(step) === remembered));
}

export function rememberUtilityStep(memoryKey: string | undefined, step: UtilityRequestStep): void {
  // 最小请求体同时丢掉了输出上限和思考参数;记住它会让之后所有调用方
  // (不同的 maxTokens)都从这里起步、再也回不到带参数的写法。
  if (!memoryKey || step.minimalBody) return;
  rememberedSteps.delete(memoryKey);
  if (rememberedSteps.size >= REMEMBERED_STEP_LIMIT) {
    const oldest = rememberedSteps.keys().next().value;
    if (oldest !== undefined) rememberedSteps.delete(oldest);
  }
  rememberedSteps.set(memoryKey, utilityRequestStepKey(step));
}

/** 测试用:清空进程内记住的写法。 */
export function resetUtilityReasoningMemory(): void {
  rememberedSteps.clear();
}
