import {
  movedCindyAutoSourceId,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';

import { isSupportedRuntimeEffort } from './runtimeSelectionAxes.js';

/**
 * 进行中任务跟随服务端挪动的 Auto。
 *
 * 模型组 Auto（`auto/<组ID>`）挂在 Cindy AI 还是企业号池供应商下由服务端决定，管理员在
 * 平台模型与号池模型之间切换目标后，同一个模型 ID 会换到另一家供应商。目录刷新后，把仍记着
 * 旧来源的进行中任务登记为「下一条消息前切换」：引擎与模型 ID 不变，只换供应商（随之换 Key），
 * 沿用系统按配置发起的切换流程。不抢占运行中的轮次，不覆盖已登记的切换或运行时改道。
 */

export interface CindyAutoRoute {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean;
}

/** 该路由的 Auto 已被服务端挪到另一家 Cindy 来源时返回新来源，否则 null。 */
export function movedCindyAutoProviderId(
  providers: readonly ProviderView[],
  route: CindyAutoRoute,
): string | null {
  return movedCindyAutoSourceId(providers, {
    agent: route.agentKind,
    model: route.model,
    providerId: route.providerId,
  });
}

export interface CindyAutoRouteFollowDeps {
  /** 本机进行中、正在用 Auto 的任务（目录刷新时的粗筛，加锁后会重读）。 */
  listCandidates(): Promise<readonly ({ sessionId: string } & CindyAutoRoute)[]>;
  listProviders(): Promise<readonly ProviderView[]>;
  withSessionLock(sessionId: string, run: () => Promise<void>): Promise<void>;
  /** 加锁后重读任务当前实际路由；已有登记的切换或运行时改道时返回 null，不覆盖。 */
  readRoute(sessionId: string): Promise<CindyAutoRoute | null>;
  /** 登记下一条消息前的切换（调用方已持有该任务的 send 锁）。 */
  stage(sessionId: string, route: CindyAutoRoute): Promise<void>;
  assertCurrent(): void;
  logger?: { info(message: string, meta?: Record<string, unknown>): void };
}

/** 返回本次登记了切换的任务数；单个任务失败只记日志，不影响其余任务。 */
export async function followMovedCindyAutoRoutes(deps: CindyAutoRouteFollowDeps): Promise<number> {
  const candidates = await deps.listCandidates();
  if (candidates.length === 0) return 0;
  const providers = await deps.listProviders();
  deps.assertCurrent();
  let staged = 0;
  for (const candidate of candidates) {
    if (!movedCindyAutoProviderId(providers, candidate)) continue;
    try {
      await deps.withSessionLock(candidate.sessionId, async () => {
        deps.assertCurrent();
        const route = await deps.readRoute(candidate.sessionId);
        const providerId = route ? movedCindyAutoProviderId(providers, route) : null;
        if (!route || !providerId) return;
        // Auto 没有推理档位，任务里存的是空串；登记切换只接受合法档位或 null。
        const effort = isSupportedRuntimeEffort(route.effort) ? route.effort : null;
        await deps.stage(candidate.sessionId, { ...route, providerId, effort });
        staged += 1;
        deps.logger?.info('Cindy Auto moved provider; staged switch for next message', {
          sessionId: candidate.sessionId,
          model: route.model,
          from: route.providerId,
          to: providerId,
        });
      });
    } catch (error) {
      deps.assertCurrent();
      deps.logger?.info('Cindy Auto provider follow failed; task keeps its route', {
        sessionId: candidate.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return staged;
}
