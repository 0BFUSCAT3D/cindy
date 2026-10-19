import { createHash, randomUUID } from 'node:crypto';
import type {
  PluginTargetCandidate,
  PluginTargetDelivery,
  PluginTargetKind,
  PluginTargetRef,
  PluginTargetRequest,
  PluginTargetView,
} from '../../shared/pluginTargets.js';
import type { PluginTaskRoute } from '../../shared/pluginTasks.js';
import {
  getActiveDataOwnerPushStamp,
  ownerScopedUserDataPath,
  activeOwnerScopeKey,
} from '../appSessionState.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { parsePluginMessageAttachments, type PluginMessageImage } from '../cindy-media/pluginMessageAttachments.js';

interface Receipt {
  hash: string | null;
  clientId: string;
  taskId?: string;
  status: 'pending' | 'accepted' | 'cancelled';
  delivery?: PluginTargetDelivery;
}
interface Ledger {
  receipts: Record<string, Receipt>;
}
export interface PluginTargetAdapter {
  candidates(kind: PluginTargetKind): Promise<PluginTargetCandidate[]>;
  create(
    pluginId: string,
    project: string,
    taskId: string,
    title: string,
    route: PluginTaskRoute | undefined,
    guard: () => void,
  ): Promise<void>;
  session(kind: 'task' | 'bot', id: string): Promise<string>;
  send(
    pluginId: string,
    taskId: string,
    clientId: string,
    text: string,
    guard: () => void,
    validateTarget: () => Promise<void>,
    delivery: PluginTargetDelivery,
    images?: PluginMessageImage[],
  ): Promise<PluginTargetDelivery>;
  withdraw(taskId: string, clientId: string, guard: () => void): Promise<void>;
}
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};
const keyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
const kinds = ['project', 'task', 'bot'];
const isTarget = (value: unknown): value is PluginTargetRef => {
  const target = value as PluginTargetRef | null;
  return !!target && kinds.includes(target.kind) && typeof target.id === 'string' &&
    target.id.length > 0 && target.id.length <= 4096 && !target.id.includes('\0');
};
const ledger = createOverrideSettingsFile<Ledger>({
  filePath: () => ownerScopedUserDataPath('plugin-target-deliveries.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { receipts: {} },
  normalize: (raw) => {
    const value = raw as Ledger | null;
    return { receipts: value?.receipts && typeof value.receipts === 'object' ? value.receipts : {} };
  },
  log: desktopMakerLogger.child('plugin-target-deliveries'),
  label: 'plugin-target-deliveries',
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});
/** UI and fixed target configuration belong to plugins; the Host validates and delivers. */
export class PluginTargetSlot {
  adapter: PluginTargetAdapter | null = null;
  private inFlight = new Map<string, { hash: string; result: Promise<unknown> }>();
  private cancelled = new Set<string>();
  private readReceipt(key: string): Receipt | undefined {
    ledger.invalidateIfChanged();
    return ledger.read().receipts[key];
  }
  async handle(pluginId: string, raw: unknown, authorized: () => void): Promise<unknown> {
    authorized();
    if (!this.adapter) return fail('HOST_NOT_READY');
    const adapter = this.adapter;
    const request = raw as PluginTargetRequest;
    if (!request || !['list', 'resolve', 'send', 'cancel'].includes(request.kind))
      return fail('INVALID_PARAMS');
    const resolve = async (target: PluginTargetRef): Promise<PluginTargetView> => {
      const candidates = await adapter.candidates(target.kind);
      authorized();
      const found = candidates.find((item) => item.id === target.id);
      if (!found) return fail('TARGET_UNAVAILABLE');
      return { kind: target.kind, id: found.id, label: found.label, detail: found.detail };
    };
    if (request.kind === 'list') {
      if (!kinds.includes(request.targetKind)) return fail('INVALID_PARAMS');
      const candidates = await adapter.candidates(request.targetKind);
      authorized();
      return { targets: candidates.map((item) => ({ ...item, kind: request.targetKind })) };
    }
    if (request.kind === 'resolve') {
      if (!isTarget(request.target)) return fail('INVALID_PARAMS');
      return resolve(request.target);
    }
    if (!keyString(request.requestKey)) return fail('INVALID_PARAMS');
    // Stable across Host restarts and plugin upgrades; owner isolation comes from the file path.
    const receiptKey = createHash('sha256').update(JSON.stringify([pluginId, request.requestKey])).digest('hex');
    const runtimeKey = JSON.stringify([
      activeOwnerScopeKey(), getActiveDataOwnerPushStamp().ownerGeneration, receiptKey,
    ]);
    if (request.kind === 'cancel') {
      this.cancelled.add(runtimeKey);
      let previous: Receipt | undefined;
      await ledger.updateAtomic(({ value }) => {
        authorized();
        previous = value.receipts[receiptKey];
        return { receipts: { ...value.receipts, [receiptKey]: {
          ...(previous ?? { hash: null, clientId: randomUUID() }), status: 'cancelled',
        } } };
      });
      authorized();
      if (previous?.taskId) {
        // Withdraw only this plugin input. Never stop another user's running turn.
        await adapter.withdraw(previous.taskId, previous.clientId, authorized);
        authorized();
      }
      return { cancelled: true, runningWorkMayHaveStarted: !!previous?.taskId };
    }
    if (
      !isTarget(request.target) ||
      typeof request.text !== 'string' || !request.text.trim() || request.text.length > 64000 ||
      (request.delivery !== undefined && !['queue', 'steer'].includes(request.delivery)) ||
      (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 200))
    ) return fail('INVALID_PARAMS');
    const target = request.target;
    const delivery = request.delivery ?? 'queue';
    if (target.kind === 'project' && delivery === 'steer') return fail('INVALID_PARAMS');
    if (request.route !== undefined) {
      const route = request.route;
      if (
        target.kind !== 'project' || !route || !['cc', 'codex', 'pi'].includes(route.agentKind) ||
        !keyString(route.providerId) || typeof route.model !== 'string' || !route.model.trim() ||
        route.model.length > 256 || typeof route.effort !== 'string' || route.effort.length > 32 ||
        typeof route.fastMode !== 'boolean'
      ) return fail('INVALID_PARAMS');
    }
    const route = request.route && {
      agentKind: request.route.agentKind, providerId: request.route.providerId,
      model: request.route.model, effort: request.route.effort, fastMode: request.route.fastMode,
    };
    const images = parsePluginMessageAttachments(request.attachments);
    const hash = createHash('sha256')
      .update(JSON.stringify([target.kind, target.id, request.text, request.title, route, delivery,
        images.map(({ hash, name }) => [hash, name])]))
      .digest('hex');
    const guard = () => {
      authorized();
      if (this.cancelled.has(runtimeKey) || this.readReceipt(receiptKey)?.status === 'cancelled')
        fail('SUPERSEDED');
    };
    guard();
    const pending = this.inFlight.get(runtimeKey);
    if (pending) {
      if (pending.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
      return pending.result;
    }
    const deliver = async () => {
      const existing = this.readReceipt(receiptKey);
      if (existing) {
        if (existing.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
        if (existing.status === 'accepted')
          return { taskId: existing.taskId, accepted: true, delivery: existing.delivery };
        return fail('DELIVERY_UNCERTAIN');
      }
      const candidate = await resolve(target);
      guard();
      const receipt: Receipt = {
        hash, clientId: randomUUID(), status: 'pending',
        taskId: target.kind === 'project' ? randomUUID() : await adapter.session(target.kind, target.id),
      };
      guard();
      // Reserve before creating a task or delivering. An interrupted reservation never replays.
      await ledger.updateAtomic(({ value }) => {
        guard();
        const previous = value.receipts[receiptKey];
        if (previous) {
          if (previous.hash !== hash) fail('REQUEST_KEY_CONFLICT');
          fail('DELIVERY_UNCERTAIN');
        }
        return { receipts: { ...value.receipts, [receiptKey]: receipt } };
      });
      guard();
      const taskId = receipt.taskId!;
      const validateTarget = async () => {
        await resolve(target);
        guard();
        if (target.kind !== 'project' && (await adapter.session(target.kind, target.id)) !== taskId)
          fail('TARGET_UNAVAILABLE');
        guard();
      };
      await validateTarget();
      if (target.kind === 'project')
        await adapter.create(pluginId, target.id, taskId, request.title || candidate.label, route, guard);
      guard();
      const actualDelivery = await adapter.send(
        pluginId, taskId, receipt.clientId, request.text, guard, validateTarget, delivery, images,
      );
      await ledger.updateAtomic(({ value }) => {
        authorized();
        const current = value.receipts[receiptKey];
        if (current?.status === 'cancelled') return {};
        return { receipts: { ...value.receipts, [receiptKey]: {
          ...receipt, status: 'accepted', delivery: actualDelivery,
        } } };
      });
      authorized();
      if (this.cancelled.has(runtimeKey) || this.readReceipt(receiptKey)?.status === 'cancelled') {
        await adapter.withdraw(taskId, receipt.clientId, authorized);
        return fail('SUPERSEDED');
      }
      return { taskId, accepted: true, delivery: actualDelivery };
    };
    const result = deliver().finally(() => this.inFlight.delete(runtimeKey));
    this.inFlight.set(runtimeKey, { hash, result });
    return result;
  }
}
