import { DL_SUBSCRIBE_CHANNEL, DL_UNSUBSCRIBE_CHANNEL, REMOTE_AGENT_CHANNEL, type ProviderShareOwned, type ProviderShareReceived, type SharedTaskDetail, type Topic, scrubSharedProvider } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';
import type { InvocationContext } from '../contracts.js';
import type { TerminalRemoteAccountService } from './account.js';
import type { TerminalPeerIdentity, TerminalScopedAuthority } from './types.js';

const SHARE_CHANNELS = new Set([REMOTE_AGENT_CHANNEL, 'maker:provider:list', 'maker:get-capabilities', 'maker:list-available-agents', 'maker:agent:status']);
const TASK_CHANNELS = new Set([
  DL_SUBSCRIBE_CHANNEL, DL_UNSUBSCRIBE_CHANNEL,
  'local-db:sessions:get', 'local-db:messages:list', 'local-db:messages:view', 'local-db:messages:view-intent',
  'local-db:messages:work-details', 'local-db:messages:around', 'local-db:messages:around-client-id',
  'local-db:messages:estimatedSessionValue', 'maker:input:get-projection', 'maker:session-in-turn',
  'maker:session-background-activity', 'maker:session-background-tasks:list', 'maker:background-task:output-tail',
  'maker:get-context-usage', 'maker:get-pending-interactions', 'maker:send', 'maker:steer',
  'maker:abort-session', 'maker:resolve-interaction',
]);
const TASK_PUSH_CHANNELS = new Set([
  'maker:event', 'maker:event:batch', 'maker:status-changed', 'maker:interaction-request',
  'maker:interaction-dismissed', 'maker:session-sync', 'local-db:messages:created', 'local-db:messages:updated',
  'local-db:sessions:created', 'local-db:sessions:patched', 'local-db:sessions:activity',
  'local-db:session:error-persisted', 'usage:session-spend-changed', 'usage:session-tokens-changed',
]);

/** Membership is read from the service, never inferred from a peer-supplied
 * task/provider id. An unavailable refresh does not turn into owner authority. */
export class TerminalMembershipService {
  private readonly owner: string | null;
  private closed = false;
  private owned: ProviderShareOwned[] = [];
  private received: ProviderShareReceived[] = [];
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  private tasks = new Map<string, { value: SharedTaskDetail; at: number }>();
  private timer?: NodeJS.Timeout;
  constructor(private readonly options: {
    account: TerminalRemoteAccountService;
    getOwnerScope(): string | null;
    getDeviceId(): string;
    onRevoked?(source: { shareId: string; memberId: string }): void;
  }) { this.owner = options.getOwnerScope(); }
  private assertCurrent() { if (this.closed || this.owner === null || this.options.getOwnerScope() !== this.owner) throw new Error('OWNER_CHANGED'); }
  async refresh(): Promise<void> {
    this.assertCurrent();
    if (this.refreshing) return this.refreshing;
    const work = (async () => {
      const [owned, received] = await Promise.all([this.options.account.providerShares.listOwned(), this.options.account.providerShares.listReceived()]);
      this.assertCurrent();
      for (const previous of this.owned) for (const member of previous.members) {
        if (member.status === 'active' && !owned.some(share => share.shareId === previous.shareId && share.members.some(next => next.memberId === member.memberId && next.status === 'active'))) {
          this.options.onRevoked?.({ shareId: previous.shareId, memberId: member.memberId });
        }
      }
      this.owned = owned.filter(share => share.hostDeviceId === this.options.getDeviceId());
      this.received = received; this.refreshedAt = Date.now();
    })();
    this.refreshing = work;
    try { await work; } finally {
      if (this.refreshing === work) this.refreshing = undefined;
      clearTimeout(this.timer);
      if (!this.closed) { this.timer = setTimeout(() => { void this.refresh().catch(() => undefined); }, 60_000); this.timer.unref(); }
    }
  }
  private share(source: Extract<TerminalPeerIdentity, { kind: 'provider-share' }>) {
    if (source.role !== 'guest' || !source.memberId || Date.now() - this.refreshedAt > 120_000) return null;
    return this.owned.find(share => share.shareId === source.shareId && share.members.some(member => member.memberId === source.memberId && member.status === 'active')) ?? null;
  }
  guestAccess(peer: string): { providerId: string; memberId: string } | null {
    // The caller must pass a source accepted by resolve, not an arbitrary peer.
    const source = this.sources.get(peer);
    if (!source || source.kind !== 'provider-share') return null;
    const share = this.share(source);
    return share ? { providerId: share.providerId, memberId: source.memberId! } : null;
  }
  private sources = new Map<string, Exclude<TerminalPeerIdentity, { kind: 'owner' }>>();
  receivedShares(): readonly ProviderShareReceived[] { return this.received; }
  async list() { if (Date.now() - this.refreshedAt >= 5_000) await this.refresh(); return { owned: this.owned, received: this.received }; }
  async resolve(source: Exclude<TerminalPeerIdentity, { kind: 'owner' }>): Promise<TerminalScopedAuthority | null> {
    this.assertCurrent();
    if (source.kind === 'provider-share') {
      if (Date.now() - this.refreshedAt >= 5_000) await this.refresh();
      if (!this.share(source)) return null;
      this.sources.set(source.peerId, source);
      return { allowedChannels: SHARE_CHANNELS, allowedTopics: new Set(), assertCurrent: () => { this.assertCurrent(); if (!this.share(source)) throw new Error('MEMBERSHIP_REVOKED'); } };
    }
    if (source.role !== 'guest' || !source.memberId) return null;
    let entry = this.tasks.get(source.sharedTaskId);
    if (!entry || Date.now() - entry.at >= 5_000) {
      const value = await this.options.account.sharedTasks.get(source.sharedTaskId); this.assertCurrent();
      entry = { value, at: Date.now() }; this.tasks.set(source.sharedTaskId, entry);
    }
    const current = () => {
      this.assertCurrent();
      const row = this.tasks.get(source.sharedTaskId);
      if (!row || row.value.hostDeviceId !== this.options.getDeviceId() || row.value.status !== 'active' || Date.now() - row.at > 120_000) throw new Error('MEMBERSHIP_REVOKED');
      const member = row.value.guests.find(guest => guest.memberId === source.memberId && guest.deviceIds.includes(source.deviceId));
      if (!member) throw new Error('MEMBERSHIP_REVOKED');
      return { row: row.value, member };
    };
    try { current(); } catch { return null; }
    this.sources.set(source.peerId, source);
    return { allowedChannels: TASK_CHANNELS, allowedTopics: new Set<Topic>([`session:${entry.value.sessionId}`]), allowedPushChannels: TASK_PUSH_CHANNELS, assertCurrent: () => { current(); } };
  }
  taskContext(source: TerminalPeerIdentity): InvocationContext['sharedTask'] | undefined {
    if (source.kind !== 'shared-task') return undefined;
    this.assertCurrent();
    const entry = this.tasks.get(source.sharedTaskId);
    const member = entry?.value.guests.find(guest => guest.memberId === source.memberId && guest.deviceIds.includes(source.deviceId));
    if (!entry || !member) throw new Error('MEMBERSHIP_REVOKED');
    return { sharedTaskId: source.sharedTaskId, sessionId: entry.value.sessionId, memberId: member.memberId, accountId: member.accountId,
      name: entry.value.memberLabels.find(label => label.memberId === member.memberId)?.displayName };
  }
  projectProviders(source: TerminalPeerIdentity, providers: ProviderView[]): ProviderView[] {
    if (source.kind === 'owner') return providers;
    const access = this.guestAccess(source.peerId);
    if (!access) throw new Error('MEMBERSHIP_REVOKED');
    return providers.filter(provider => provider.id === access.providerId && provider.remoteInvocationEnabled === true).map(scrubSharedProvider);
  }
  close() { this.closed = true; clearTimeout(this.timer); this.sources.clear(); this.owned = []; this.received = []; this.tasks.clear(); }
}
