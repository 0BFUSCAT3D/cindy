/**
 * send_to_session 投递到另一台同账号电脑上的既有任务。
 *
 * 目标写法与 list_sessions(device=...) 返回的远程任务 id 相同：`<device_id>::<session_id>`。
 * 复用远程操作的 `maker:input:enqueue`(按 clientId 幂等、持久入队)，与手机 / 另一台电脑
 * 上用户发送同一条路径；被控端在入队边界把认证过的控制端设备与自报的来源任务盖成
 * `origin`，界面标签与 `[消息来源]` 说明都写「由电脑「X」上的任务「Y」发送」。
 *
 * 只做 jump：不在别的电脑上新建任务，也不支持委派协调用途(协调关系只在本机数据库核实)。
 */
import type { InvokeResultPayload } from '@cindy/device-link';
import { DeviceLinkError } from '@cindy/device-link';

import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { classifyRemoteHistoryError } from '../mcp-integrations/remoteChatHistory.js';
import { createOptsFromRow, type RemoteSessionRow } from './orcaRemoteWorkerRuntime.js';

export interface RemoteSessionTarget {
  deviceId: string;
  sessionId: string;
}

/** `<device_id>::<session_id>`；不是这种写法、或指向本机时返回 null(走本机路径)。 */
export function parseRemoteSessionTarget(
  value: string | undefined,
  selfDeviceId: string | null,
): RemoteSessionTarget | null {
  if (!value) return null;
  const split = value.indexOf('::');
  if (split <= 0 || split >= value.length - 2) return null;
  const deviceId = value.slice(0, split);
  const sessionId = value.slice(split + 2);
  if (deviceId === 'local' || deviceId === selfDeviceId) return null;
  return { deviceId, sessionId };
}

/** 本机 id 写成 `local::id` / `<本机 device_id>::id` 时去掉前缀。 */
export function localSessionIdOf(value: string, selfDeviceId: string | null): string {
  const split = value.indexOf('::');
  if (split <= 0) return value;
  const deviceId = value.slice(0, split);
  return deviceId === 'local' || deviceId === selfDeviceId ? value.slice(split + 2) : value;
}

export type RemoteSessionHandoffErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'ARCHIVED'
  | 'DELETED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'HOST_NOT_READY'
  | 'INTERNAL'
  | 'REMOTE_DEVICE_OFFLINE'
  | 'REMOTE_DISABLED'
  | 'REMOTE_LINK_REQUIRED'
  | 'REMOTE_ACCESS_REVOKED'
  | 'REMOTE_UNSUPPORTED'
  | 'REMOTE_TIMEOUT'
  | 'REMOTE_PAYLOAD_TOO_LARGE'
  | 'DEVICE_LINK_NOT_READY';

export type RemoteSessionHandoffResult =
  | {
      ok: true;
      targetSessionId: string;
      agentKind: 'claude-code' | 'codex' | 'pi';
      wakeKind: 'resumed' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** 远端队列句柄只在那台电脑上有效，不回传；与本机结果同形便于调用方统一处理。 */
      queuedMessageId?: undefined;
      worktreePath?: undefined;
    }
  | { ok: false; errorCode: RemoteSessionHandoffErrorCode; message: string };

export interface RemoteSessionHandoffDeps {
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
  /** 捕获当前账号；返回的断言在账号切换后抛错。 */
  captureAccess(): () => void;
  createId(): string;
  now(): number;
}

type Failure = Extract<RemoteSessionHandoffResult, { ok: false }>;

const fail = (errorCode: RemoteSessionHandoffErrorCode, message: string): Failure => ({
  ok: false,
  errorCode,
  message,
});

function classify(code: string, message: string): Failure {
  // 被控端 IPC 错误以 `[CODE] message` 编码；Review 等不接收外部输入的任务原样回报。
  const ipc = code === 'IPC_ERROR' ? /\[([A-Z0-9_]+)]\s*(.*)$/.exec(message) : null;
  if (ipc?.[1] === 'UNSUPPORTED_CAPABILITY')
    return fail('UNSUPPORTED_CAPABILITY', ipc[2] || message);
  if (code === 'PAYLOAD_TOO_LARGE')
    return fail('REMOTE_PAYLOAD_TOO_LARGE', `${message}; shorten the message`);
  const { errorCode, message: detail } = classifyRemoteHistoryError(code, message);
  return fail(errorCode as RemoteSessionHandoffErrorCode, detail);
}

async function call<T>(
  deps: RemoteSessionHandoffDeps,
  deviceId: string,
  channel: string,
  args: unknown[],
  assertCurrent: () => void,
): Promise<{ ok: true; value: T } | Failure> {
  try {
    const response = await deps.invoke(deviceId, channel, args, { preSend: assertCurrent });
    assertCurrent();
    if (!response.ok) return classify(response.error.code, response.error.message);
    return { ok: true, value: response.result as T };
  } catch (error) {
    assertCurrent();
    if (error instanceof DeviceLinkError) return classify(error.code, error.message);
    return fail('DEVICE_LINK_NOT_READY', error instanceof Error ? error.message : String(error));
  }
}

interface RemoteSessionReadRow extends RemoteSessionRow {
  title?: unknown;
  status?: unknown;
  userSendAt?: unknown;
}

export async function sendToRemoteSession(
  deps: RemoteSessionHandoffDeps,
  params: {
    target: RemoteSessionTarget;
    message: string;
    sender: { sessionId: string; title?: string | null };
  },
): Promise<RemoteSessionHandoffResult> {
  const { target } = params;
  const qualifiedId = `${target.deviceId}::${target.sessionId}`;
  let assertCurrent: () => void;
  try {
    assertCurrent = deps.captureAccess();
  } catch (error) {
    return fail('HOST_NOT_READY', error instanceof Error ? error.message : String(error));
  }
  try {
    const device = (await deps.listDevices()).devices.find(
      (row) => row.deviceId === target.deviceId && !row.isSelf,
    );
    assertCurrent();
    if (!device || ['ios', 'android'].includes(device.platform ?? ''))
      return fail(
        'NOT_FOUND',
        `device ${target.deviceId} is not a linked computer of this account`,
      );
    if (!device.controlEnabled || !device.remoteControlEnabled)
      return fail('REMOTE_DISABLED', `remote control is disabled for ${device.name}`);
    if (!device.online) return fail('REMOTE_DEVICE_OFFLINE', `${device.name} is offline`);

    const read = await call<RemoteSessionReadRow | null>(
      deps,
      target.deviceId,
      'local-db:sessions:get',
      [target.sessionId],
      assertCurrent,
    );
    if (!read.ok) return read;
    const row = read.value;
    if (!row) return fail('NOT_FOUND', `session ${qualifiedId} not found`);
    if (row.status === 'archived') return fail('ARCHIVED', `session ${qualifiedId} is archived`);
    if (row.status === 'deleted') return fail('DELETED', `session ${qualifiedId} is deleted`);

    const createOpts = createOptsFromRow(row);
    const clientId = deps.createId();
    const item: AgentInputQueuedMessage = {
      clientId,
      durableDelivery: true,
      text: params.message,
      persistedContent: params.message,
      model: createOpts.model,
      effort: createOpts.effort ?? '',
      permissionMode: createOpts.permissionMode ?? 'auto',
      workingDir: createOpts.workingDir,
      chatMessage: {
        clientId,
        role: 'user',
        content: params.message,
        createdAt: new Date(deps.now()).toISOString(),
      },
      createOpts,
      remoteSessionSender: {
        sessionId: params.sender.sessionId,
        ...(params.sender.title?.trim() ? { title: params.sender.title.trim() } : {}),
      },
    };
    const enqueued = await call<{ pendingQueue?: Array<{ clientId?: unknown }> } | null>(
      deps,
      target.deviceId,
      'maker:input:enqueue',
      [target.sessionId, item],
      assertCurrent,
    );
    if (!enqueued.ok) {
      // 超时不代表没送达：enqueue 按 clientId 幂等，但这里不盲目重发。
      if (enqueued.errorCode === 'REMOTE_TIMEOUT')
        return fail(
          'REMOTE_TIMEOUT',
          `${enqueued.message}; the message may already be delivered — check with get_chat_history before resending`,
        );
      return enqueued;
    }
    const stillQueued =
      enqueued.value?.pendingQueue?.some((entry) => entry?.clientId === clientId) === true;
    return {
      ok: true,
      targetSessionId: qualifiedId,
      agentKind: createOpts.agentKind,
      wakeKind: stillQueued ? 'queued' : 'resumed',
      targetTitle: typeof row.title === 'string' ? row.title : null,
      targetLastUserSendAt:
        typeof row.userSendAt === 'number' ? new Date(row.userSendAt).toISOString() : null,
    };
  } catch (error) {
    // 账号切换：调用方身份已失效，不回报任何远端结果。
    return fail('HOST_NOT_READY', error instanceof Error ? error.message : String(error));
  }
}
