/**
 * 本机窗口的组命令入口；同账号远程管理由专用命令转交组所在电脑。
 */
import { ipcMain } from 'electron';

import { activeOwnerScopeKey } from '../appSessionState.js';

import {
  PROVIDER_GROUP_IPC,
  isProviderGroupProviderId,
  normalizeProviderGroupConfig,
  parseProviderGroupRemoteView,
  type ProviderGroupCommand,
  type ProviderGroupLocalCommand,
  type ProviderGroupConfig,
  type ProviderGroupSessionGroup,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { broadcast, getSelfDeviceId, remoteBackgroundInvoke, remoteInvoke } from '../device-link/index.js';
import { isProviderManagementRequest } from '../../shared/providerManagement.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { createLogger } from '../logger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { pruneProviderGroupBindings } from './bindings.js';
import type { ProviderGroupDirectory } from './directory.js';
import type { ProviderGroupRouter } from './router.js';
import {
  getProviderGroupDirectory,
  getProviderGroupRemoteClient,
  getProviderGroupRouter,
  readProviderGroupOfSession,
} from './runtime.js';
import { listProviderGroups, readProviderGroup, writeProviderGroup } from './store.js';
import { invokeProviderManagement } from './managementClient.js';
import { captureProviderManagementScope } from './managementScope.js';

const log = createLogger('provider-group');

export interface ProviderGroupCommandDeps {
  router: ProviderGroupRouter;
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  writeGroup(providerId: string, config: unknown, expectedConfig?: ProviderGroupConfig | null): Promise<ProviderGroupConfig | null>;
  /** 解除指向已不在组里的电脑的任务绑定；keep 为 null = 整个组已删除。 */
  pruneBindings(providerId: string, keep: ReadonlySet<string> | null): Promise<void>;
  /** 当前账号：等远端目录期间换了账号时不写入(否则会把上一个账号的组写进新账号)。 */
  ownerKey(): string;
  /** 另一台电脑上某个供应商的组与组内电脑状态(设置页只读展示)。 */
  remoteView(deviceId: string, providerId: string): Promise<ProviderGroupView>;
  /** 本机设备 id(另一台电脑的组里可能也有本机这台)。 */
  localDeviceId(): string | null;
  /** 本机全部组的设置(不读远端，模型列表据此收起本机组里的远程供应商)。 */
  listGroups(): Record<string, ProviderGroupConfig>;
  /** 这个任务此刻归哪个组(只读本机记录)。 */
  sessionGroup(sessionId: string): Promise<ProviderGroupSessionGroup>;
  changed(providerId: string): void;
}

const REMOTE_DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parseProviderGroupCommand(raw: unknown): ProviderGroupCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throwIpcError('INVALID_PARAMS', 'command required');
  const value = raw as Record<string, unknown>;
  if (value.action === 'remote-manage') {
    if (typeof value.deviceId !== 'string' || !REMOTE_DEVICE_ID_PATTERN.test(value.deviceId)
      || !isProviderManagementRequest(value.request) || !value.request.command
      || typeof value.request.command !== 'object' || Array.isArray(value.request.command)) {
      throwIpcError('INVALID_PARAMS', 'Invalid remote provider management command');
    }
    return { action: 'remote-manage', deviceId: value.deviceId, request: value.request };
  }
  if (value.action === 'list') return { action: 'list' };
  if (value.action === 'session-group') {
    if (typeof value.sessionId !== 'string' || !SESSION_ID_PATTERN.test(value.sessionId)) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    return { action: 'session-group', sessionId: value.sessionId as string };
  }
  if (!isProviderGroupProviderId(value.providerId)) throwIpcError('INVALID_PARAMS', 'providerId required');
  const providerId = value.providerId as string;
  switch (value.action) {
    case 'get':
    case 'candidates':
    case 'delete':
      return { action: value.action, providerId };
    case 'remote-view': {
      if (typeof value.deviceId !== 'string' || !REMOTE_DEVICE_ID_PATTERN.test(value.deviceId)) {
        throwIpcError('INVALID_PARAMS', 'deviceId required');
      }
      return { action: 'remote-view', providerId, deviceId: value.deviceId as string };
    }
    case 'save': {
      if (!value.config || typeof value.config !== 'object') throwIpcError('INVALID_PARAMS', 'config required');
      return { action: 'save', providerId, config: value.config as ProviderGroupConfig };
    }
    case 'save-if-current':
    case 'delete-if-current': {
      const expectedConfig = normalizeProviderGroupConfig(value.expectedConfig, providerId);
      if (value.expectedConfig !== null && !expectedConfig) {
        throwIpcError('INVALID_PARAMS', 'expectedConfig must be a group snapshot or null');
      }
      if (value.action === 'delete-if-current') return { action: value.action, providerId, expectedConfig };
      if (!value.config || typeof value.config !== 'object' || Array.isArray(value.config)) {
        throwIpcError('INVALID_PARAMS', 'config required');
      }
      return { action: value.action, providerId, config: value.config as ProviderGroupConfig, expectedConfig };
    }
    default:
      throwIpcError('INVALID_PARAMS', 'unknown provider group action');
  }
}

/** 核对这台电脑连不连得上组里某台的上限：设置页每 15 秒重读，不能让一台慢的电脑拖住整个组的状态。 */
export const PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS = 3_000;

/** 读那台的目录：读到了 true，读失败 false，到点还没结果 null(说不准，不下结论)。 */
function readsCatalog(
  directory: Pick<ProviderGroupDirectory, 'readDeviceCatalog'>,
  agentDeviceId: string,
): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    directory.readDeviceCatalog(agentDeviceId).then(() => true, () => false),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROVIDER_GROUP_REACHABILITY_CHECK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 另一台电脑上的组：状态是组所在电脑看到的。组里的「我的其他电脑」由这台电脑直接连过去(§4 同账号直连)，
 * 组所在电脑那边看它能用、这台却读不到它的目录时标出来(`unreachableHere`)：否则这里显示能用，换电脑时却总换不过去。
 * 目录有短时缓存；每台最多等 3 秒，到点还没结果的不标，照组所在电脑的状态显示。
 */
export async function markMembersUnreachableHere(
  view: ProviderGroupView,
  directory: Pick<ProviderGroupDirectory, 'readDeviceCatalog'>,
  selfDeviceId: string | null,
): Promise<ProviderGroupView> {
  if (!view.config || !selfDeviceId) return view;
  const usable = new Set(view.members.filter((m) => m.state === 'available' || m.state === 'full').map((m) => m.key));
  const direct = view.config.members.filter((m) =>
    m.kind === 'device' && usable.has(m.key) && m.agentDeviceId !== null && m.agentDeviceId !== selfDeviceId);
  if (direct.length === 0) return view;
  const reads = await Promise.all(direct.map(async (m) => ({ key: m.key, ok: await readsCatalog(directory, m.agentDeviceId!) })));
  const unreachable = new Set(reads.filter((r) => r.ok === false).map((r) => r.key));
  if (unreachable.size === 0) return view;
  return {
    ...view,
    members: view.members.map((m) => (unreachable.has(m.key) ? { ...m, unreachableHere: true } : m)),
  };
}

/** 业务体(依赖注入，单测直接调)。 */
export async function executeProviderGroupCommand(deps: ProviderGroupCommandDeps, command: ProviderGroupLocalCommand) {
  const assertCurrent = captureProviderManagementScope(deps.ownerKey);
  const result = await runProviderGroupCommand(deps, command, assertCurrent);
  assertCurrent();
  return result;
}

async function runProviderGroupCommand(
  deps: ProviderGroupCommandDeps,
  command: ProviderGroupLocalCommand,
  assertCurrent: () => void,
) {
  if (command.action === 'list') return deps.listGroups();
  if (command.action === 'session-group') return deps.sessionGroup(command.sessionId);
  const { providerId } = command;
  switch (command.action) {
    case 'get':
      return deps.router.view(providerId, { includeGuestSupport: true });
    case 'remote-view': {
      const view = await deps.remoteView(command.deviceId, providerId);
      assertCurrent();
      return markMembersUnreachableHere(view, deps.directory, deps.localDeviceId());
    }
    case 'candidates':
      return deps.directory.listCandidates(providerId, deps.readGroup(providerId));
    case 'delete':
    case 'delete-if-current':
      if (command.action === 'delete-if-current') await deps.writeGroup(providerId, null, command.expectedConfig);
      else await deps.writeGroup(providerId, null);
      assertCurrent();
      await deps.pruneBindings(providerId, null);
      assertCurrent();
      deps.changed(providerId);
      return deps.router.view(providerId, { includeGuestSupport: true });
    case 'save':
    case 'save-if-current': {
      const next = normalizeProviderGroupConfig(command.config, providerId);
      if (next) {
        // 新加入的电脑必须是这台电脑已经能用的同一个供应商(§3)，不能凭渲染端点名加入。
        const previous = new Set(deps.readGroup(providerId)?.members.map((m) => m.key) ?? []);
        const added = next.members.filter((m) => m.kind !== 'local' && !previous.has(m.key));
        if (added.length > 0) {
          const candidates = await deps.directory.listCandidates(providerId, deps.readGroup(providerId));
          assertCurrent();
          const allowed = new Set(candidates.filter((c) => !c.blocked).map((c) => c.key));
          const rejected = added.filter((m) => !allowed.has(m.key));
          if (rejected.length > 0) {
            throwIpcError('PRECONDITION_FAILED', 'Only the same provider that this computer can already use can join the group');
          }
          // 显示名以目录为准，渲染端给的只是快照。
          const labels = new Map(candidates.map((c) => [c.key, c.label]));
          for (const member of next.members) {
            const label = labels.get(member.key);
            if (label) member.label = label;
          }
        }
      }
      assertCurrent();
      const written = command.action === 'save-if-current'
        ? await deps.writeGroup(providerId, next, command.expectedConfig)
        : await deps.writeGroup(providerId, next);
      assertCurrent();
      await deps.pruneBindings(providerId, written ? new Set(written.members.map((m) => m.key)) : null);
      assertCurrent();
      deps.changed(providerId);
      return deps.router.view(providerId, { includeGuestSupport: true });
    }
  }
}

export function createProviderGroupCommandDeps(): ProviderGroupCommandDeps {
  return {
    router: getProviderGroupRouter(),
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    writeGroup: writeProviderGroup,
    pruneBindings: pruneProviderGroupBindings,
    ownerKey: activeOwnerScopeKey,
    remoteView: (deviceId, providerId) => getProviderGroupRemoteClient().view(deviceId, providerId, { includeGuestSupport: true }),
    localDeviceId: getSelfDeviceId,
    listGroups: listProviderGroups,
    sessionGroup: readProviderGroupOfSession,
    changed: (providerId) => {
      try {
        broadcast(PROVIDER_GROUP_IPC.CHANGED, { providerId });
        // 同账号其他电脑的模型列表按本机目录里的组摘要收起组内电脑：组变化后让它们重读目录。
        tapWindowBroadcast(MAKER_PUSH.PROVIDER_CHANGED, {});
      } catch (error) {
        log.warn('provider group broadcast failed', { error: String(error) });
      }
    },
  };
}

export function registerProviderGroupIpc(): void {
  const deps = createProviderGroupCommandDeps();

  ipcMain.handle(PROVIDER_GROUP_IPC.COMMAND, async (event, raw: unknown) => {
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Provider groups are local only');
    assertTrustedAppRendererEvent(event);
    const command = parseProviderGroupCommand(raw);
    if (command.action === 'remote-manage') {
      const assertOwner = captureProviderManagementScope(deps.ownerKey);
      const result = await invokeProviderManagement(remoteInvoke, command.deviceId, command.request, remoteBackgroundInvoke);
      assertOwner();
      if (command.request.action !== 'manage-group' || command.request.command.action === 'candidates') return result;
      // 管理读取与保存后的组视图也按查看端直连能力投影，不能把组所在电脑看到的可用误当成本机可达。
      const view = await markMembersUnreachableHere(
        parseProviderGroupRemoteView(result, command.request.command.providerId),
        deps.directory,
        deps.localDeviceId(),
      );
      assertOwner();
      return view;
    }
    return executeProviderGroupCommand(deps, command);
  });
}
