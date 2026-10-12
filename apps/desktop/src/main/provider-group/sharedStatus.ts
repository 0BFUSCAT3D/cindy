/** 受邀者可见的组状态：白名单投影，不携带组员身份和用量，也不分配任务或改变冷却。 */
import type { ProviderShareGroupState, RemoteAgentCaps } from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupGuestSupport, ProviderGroupMember } from '../../shared/providerGroup.js';
import type { ProviderGroupOwnerScope } from './runtime.js';

export const SHARED_GROUP_STATUS_TIMEOUT_MS = 3_000;

export interface SharedGroupStatusDeps {
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  readCaps(member: ProviderGroupMember): Promise<RemoteAgentCaps>;
  isIncapable(agentDeviceId: string): boolean;
}

async function readWithin<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SHARED_GROUP_STATUS_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 一次详情读取内按电脑合并能力查询；沿用真正接收分享任务时的能力条件。 */
export function createGuestSupportReader(readCaps: SharedGroupStatusDeps['readCaps']) {
  const caps = new Map<string, Promise<RemoteAgentCaps | null>>();
  return async (member: ProviderGroupMember): Promise<ProviderGroupGuestSupport> => {
    if (!member.agentDeviceId) return 'supported';
    let pending = caps.get(member.agentDeviceId);
    if (!pending) {
      pending = readWithin(() => readCaps(member));
      caps.set(member.agentDeviceId, pending);
    }
    const capability = await pending;
    if (!capability) return 'unknown';
    return capability.virtualWorkspace === true && (member.kind !== 'device' || capability.guestRelay === true)
      ? 'supported' : 'needs-update';
  };
}

export async function readSharedGroupStatus(deps: SharedGroupStatusDeps, providerId: string): Promise<ProviderShareGroupState[] | null> {
  const scope = deps.scope();
  const config = deps.readGroup(providerId);
  if (!config) return null;
  const view = await readWithin(() => scope.router.view(providerId));
  if (!scope.isCurrent()) return null;
  const readSupport = createGuestSupportReader(deps.readCaps);
  const states = await Promise.all(config.members.map(async (member): Promise<ProviderShareGroupState> => {
    if (member.paused) return 'paused';
    const status = view?.members.find((item) => item.key === member.key);
    if (!status) return 'unknown';
    if (status.state !== 'available' && status.state !== 'full') return status.state;
    if (member.agentDeviceId) {
      // 与实际接任务的条件一致；旧版同账号组员可能主人能用，受邀者却不能用。
      if (member.kind === 'device' && deps.isIncapable(member.agentDeviceId)) return 'needs-update';
      const support = await readSupport(member);
      if (support !== 'supported') return support;
    }
    // 满载仍能接任务；只报粗略忙闲，绝不返回任务数和上限。
    return status.running > 0 || status.state === 'full' ? 'busy' : 'available';
  }));
  // 读取期间换账号或编辑组时丢弃快照，避免将旧组状态贴到新组序号上。
  const latest = deps.readGroup(providerId);
  return scope.isCurrent() && JSON.stringify(latest) === JSON.stringify(config) ? states : null;
}
