import { pickModelMetadata } from '@cindy/model-providers';
/**
 * codex-model-discovery —— 从 codex 的 `models_cache.json` 派生出规范化的 Codex 模型快照。
 * active-catalog 再把同一份快照投影到 Codex 与 Claude bridge,避免两边名称、排序各维护一套。
 *
 * 数据源:codex app-server / CLI 维护的 `<codexHome>/models_cache.json`(与 live 端点
 * `chatgpt.com/backend-api/codex/models` 同结构)。筛选同时依赖后端可见性字段与客户端维护的
 * 内部模型 ID 集合，避免上游把内部别名标成可见时泄漏到用户模型列表。
 *
 * 只读、纯派生。读取失败返回 null(保留上次快照 / 静态兜底),合法空 cache 返回 []。
 * mapper 与 fs 读分离:`mapCodexModelsToCatalog` 是纯函数(单测覆盖),`readCodexDiscoveredModels`
 * 只负责验证 Cindy OAuth 边界并读自管 cache。
 */

import { app } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { defaultEffortForCapabilities, type CatalogModel } from '@cindy/model-providers';
import type { CodexModelListItem } from '@cindy/maker-core';

import { shouldSuppressLocalCodexAuth } from './codex-auth-invalidation.js';
import { isNativeProviderAuthBound } from './nativeProviderAuthBinding.js';

import { CODEX_EFFORTS, isInternalCodexModelId, positiveTokens, str, mapCodexModelsToCatalog } from '@cindy/model-providers/provider-auth/codex-model-discovery';
export { mapCodexModelsToCatalog };

/**
 * app-server `model/list` 快照 → 规范化目录。
 *
 * live 协议不暴露 cache 的 context_window / priority，故上下文使用 Codex 当前统一窗口
 * 272k，排序严格保留 app-server 返回顺序。后续 `models_cache.json` 可读时仍可用上面的
 * mapper 提供更细元数据；首次 OAuth 的关键是绝不能因为 cache 尚未落盘而发布空目录。
 */
export function mapCodexAppServerModelsToCatalog(
  models: readonly CodexModelListItem[],
): CatalogModel[] {
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of models.entries()) {
    if (!raw || raw.hidden === true) continue;
    const modelId = str(raw.model);
    const itemId = str(raw.id);
    if (
      (modelId && isInternalCodexModelId(modelId)) ||
      (itemId && isInternalCodexModelId(itemId))
    ) {
      continue;
    }
    const slug = modelId ?? itemId;
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((item) => (item && typeof item === 'object' ? str(item.reasoningEffort) : null))
          .filter((effort): effort is string => effort != null && CODEX_EFFORTS.has(effort))
      : [];
    const requestedDefault = str(raw.defaultReasoningEffort);
    const defaultEffort =
      requestedDefault && efforts.includes(requestedDefault)
        ? (requestedDefault as CatalogModel['defaultEffort'])
        : defaultEffortForCapabilities(efforts as CatalogModel['efforts']);
    const tiers = [
      ...(Array.isArray(raw.serviceTiers) ? raw.serviceTiers.map((tier) => tier?.id) : []),
      ...(Array.isArray(raw.additionalSpeedTiers) ? raw.additionalSpeedTiers : []),
    ];
    const supportsFastMode = tiers.some((tier) => tier === 'priority' || tier === 'fast');
    const model: CatalogModel = {
      id: slug,
      discoveredMetadata: pickModelMetadata({
        name: str(raw.displayName),
        description: str(raw.description),
        efforts: Array.isArray(raw.supportedReasoningEfforts) ? efforts : undefined,
        defaultEffort: requestedDefault,
        supportsFastMode:
          Array.isArray(raw.serviceTiers) || Array.isArray(raw.additionalSpeedTiers)
            ? supportsFastMode
            : undefined,
      }),
      name: str(raw.displayName) ?? slug,
      group: 'gpt',
      // app-server 已按官方 picker 顺序返回；按返回位置记账户顺序。
      sortOrder: index,
      ...(str(raw.description) ? { description: raw.description } : {}),
      // 刻意**不**设 contextWindowVerified: live 协议不给 context_window, 这 272k 是
      // 统一兜底而非该模型的真实上限。标了它就会被拿去收敛运行期上报的窗口, 把真实
      // 更大的窗口(例如 400k 的 gpt-5.6)压成 272k, 上下文占比与 memory flush 全偏早。
      contextWindow: 272_000,
      efforts: efforts as CatalogModel['efforts'],
      defaultEffort,
      status: 'active',
      defaultEnabled: true,
      ...(Array.isArray(raw.serviceTiers) || Array.isArray(raw.additionalSpeedTiers)
        ? { supportsFastMode }
        : {}),
      supportsUltrafastMode: tiers.includes('ultrafast'),
    };
    if (efforts.includes('xhigh')) model.effortDisplayNames = { xhigh: 'Extra High' };
    out.push(model);
  }
  return out;
}

/** Cindy 自管的 Codex home；系统 ~/.codex 属于独立登录边界，不能混读其账号缓存。 */
function desktopCodexHome(): string {
  return path.join(app.getPath('userData'), 'codex-home');
}

/** 仅在 Cindy 当前确有未被 disconnect marker 抑制的 OAuth token 时读取模型 cache。 */
async function hasActiveDesktopCodexOAuth(codexHome: string): Promise<boolean> {
  if (!isNativeProviderAuthBound('openai')) return false;
  const authPath = path.join(codexHome, 'auth.json');
  if (shouldSuppressLocalCodexAuth(codexHome, authPath)) return false;
  try {
    const raw: unknown = JSON.parse(await fsp.readFile(authPath, 'utf-8'));
    const accessToken = (raw as { tokens?: { access_token?: unknown } } | null)?.tokens
      ?.access_token;
    return typeof accessToken === 'string' && accessToken.length > 0;
  } catch {
    return false;
  }
}

/**
 * 读 codex models_cache.json 并派生规范化快照。失败(文件缺失 / 非 JSON / 非 cache 结构)
 * 返回 null;合法 cache 即使 models 为空也返回 [],让调用方区分「上游空」与「没读到」。
 * cache 本身没有账号 ID，不能回退读取系统 ~/.codex 的 cache；否则 Cindy 登出或切换
 * ChatGPT 账号后会把系统/上一账号的有效旧 cache 重新发布为当前模型。
 * 异步读 —— 调用点在 catalog 加载的 promise 链里,不在 splash 关键路径塞同步 IO。
 */
export async function readCodexDiscoveredModels(): Promise<CatalogModel[] | null> {
  const codexHome = desktopCodexHome();
  if (!(await hasActiveDesktopCodexOAuth(codexHome))) return [];
  try {
    const raw: unknown = JSON.parse(
      await fsp.readFile(path.join(codexHome, 'models_cache.json'), 'utf-8'),
    );
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { models?: unknown }).models)) {
      return null;
    }
    return mapCodexModelsToCatalog(raw);
  } catch {
    return null;
  }
}

/**
 * 鉴权边界重读的安全语义：cache 缺失或读取异常都回空快照，不能沿用上一账号的动态模型。
 * 启动期仍直接调用 readCodexDiscoveredModels，以保留“读取失败不抹内存快照”的容错语义。
 */
export async function readCodexDiscoveredModelsForAuthRefresh(
  read: () => Promise<CatalogModel[] | null> = readCodexDiscoveredModels,
): Promise<CatalogModel[]> {
  try {
    return (await read()) ?? [];
  } catch {
    return [];
  }
}
