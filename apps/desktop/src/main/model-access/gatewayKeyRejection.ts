import { createHash } from 'node:crypto';

import type { ModelAccessCredentialSource } from '../../shared/modelAccess.js';

/**
 * gatewayKeyRejection.ts — Cindy AI Key 被网关拒绝(HTTP 401)后的统一上报入口。
 * ---------------------------------------------------------------------------
 * 服务端换发或撤销 Key 后,本机旧 Key 会被网关 401;服务端在客户端调用
 * `GET /api/model-access/credentials` 时会探测当前 Key,失效即签发新 Key。主进程各
 * 调用方(辅助模型、搜索、媒体、向量、额度、语音、智能体终态)在 401 时把**本次请求
 * 实际携带的 Key** 交给这里,由这里决定是否触发一次凭据同步。
 *
 * 规则刻意只有两条,不加冷却 / 退避 / 计时器:
 *  - 规则 A:上报的 Key 必须等于本机当前保存的 Key——旧请求的迟到 401 不能为已换上的
 *    新 Key 再触发同步;
 *  - 规则 B:每把 Key 只触发一次——内存只记上一次触发的 Key 的 SHA-256 指纹(不存明文),
 *    同一把 Key 的后续 401 全部忽略,换了 Key 之后才可能再次触发。
 * 同步用 `sync()` 而不是 `retry()`:它尊重 unsupported / disabled 终态,自带 single-flight
 * 与内部重试;失败沿用现有同步表现,这里不新增提示。
 *
 * 依赖全部注入(工厂函数),进程内单例由 model-access/index.ts 在 initModelAccess 时组装
 * 并安装。调用方从本文件导入 `reportCindyGatewayKeyRejected`,不直接依赖 index.ts——
 * 后者会拉入 maker-host 等整张主进程依赖图,不适合被底层网络模块反向导入。
 */

export interface GatewayKeyRejectionDeps {
  /** 当前会话是否允许使用 Cindy 网关(getAppCapabilities().canUseCindyGateway)。 */
  canUseCindyGateway(): boolean;
  /** 是否正处于账号切换边界(isAppSessionBoundaryPending)。 */
  isSessionBoundaryPending(): boolean;
  /** 本机 Key 的来源标记;只处理服务端下发('server')的 Key。 */
  getCredentialSource(): ModelAccessCredentialSource | null;
  /** 本机当前保存的 Cindy AI Key(providerSecretStore 'xd')。 */
  readCurrentKey(): string | null;
  /** 触发一次凭据同步(credentialsSync.sync())。 */
  requestSync(): Promise<unknown>;
  log?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export type GatewayKeyRejectionReporter = (usedKey: string | null | undefined) => void;

function keyFingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** 组装一个上报器;内存里只保留上一次已触发 Key 的指纹。 */
export function createGatewayKeyRejectionReporter(
  deps: GatewayKeyRejectionDeps,
): GatewayKeyRejectionReporter {
  let lastTriggeredFingerprint: string | null = null;

  return (usedKey) => {
    try {
      if (!usedKey) return;
      if (!deps.canUseCindyGateway()) return;
      if (deps.isSessionBoundaryPending()) return;
      if (deps.getCredentialSource() !== 'server') return;
      // 规则 A:只认本机当前这把 Key 的拒绝。
      if (deps.readCurrentKey() !== usedKey) return;
      // 规则 B:同一把 Key 只触发一次。
      const fingerprint = keyFingerprint(usedKey);
      if (fingerprint === lastTriggeredFingerprint) return;
      lastTriggeredFingerprint = fingerprint;
      deps.log?.info('Cindy AI key rejected by gateway, re-syncing credentials');
      void deps.requestSync().catch((error: unknown) => {
        deps.log?.warn(
          `Cindy AI credentials re-sync after key rejection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } catch (error) {
      // 上报发生在各调用方的错误处理路径里,任何异常都不能改变调用方原有的失败语义。
      deps.log?.warn(
        `Cindy AI key rejection report failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
}

let installedReporter: GatewayKeyRejectionReporter | null = null;

/** model-access/index.ts 初始化时安装进程内单例;传 null 卸载(仅测试复位用)。 */
export function installCindyGatewayKeyRejectionReporter(
  reporter: GatewayKeyRejectionReporter | null,
): void {
  installedReporter = reporter;
}

/**
 * 上报一次 Cindy 网关 401。只在三条同时成立时调用:请求发往 Cindy 网关、带的是
 * Cindy AI Key、响应 401。`usedKey` 传本次请求实际携带的 Key。model-access 尚未
 * 初始化时(无凭据同步可触发)直接忽略。
 */
export function reportCindyGatewayKeyRejected(usedKey: string | null | undefined): void {
  installedReporter?.(usedKey);
}

/** 从请求头里取 `Authorization: Bearer <key>` 的 key;没有或格式不对返回 null。 */
export function bearerKeyFromHeaders(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  let value: string | null | undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    value = headers.get('authorization');
  } else if (Array.isArray(headers)) {
    value = headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1];
  } else {
    const record = headers as Record<string, string | undefined>;
    const name = Object.keys(record).find((key) => key.toLowerCase() === 'authorization');
    value = name ? record[name] : undefined;
  }
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match ? match[1].trim() || null : null;
}

/**
 * 给注入式 fetch 包一层:响应 401 时,用本次请求 Authorization 头里的 Bearer key 上报。
 * 只观察状态码,不读响应体、不改请求和响应;key 是否为 Cindy AI Key 由上报器按规则 A 判定。
 */
export function withCindyGatewayKeyRejectionReport(
  fetchImpl: typeof fetch,
  report: (usedKey: string | null) => void = reportCindyGatewayKeyRejected,
): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401) {
      const usedKey =
        bearerKeyFromHeaders(init?.headers)
        ?? (typeof Request !== 'undefined' && input instanceof Request
          ? bearerKeyFromHeaders(input.headers)
          : null);
      report(usedKey);
    }
    return response;
  };
  return wrapped as typeof fetch;
}
