import { createHash, randomUUID } from 'node:crypto';
import type {
  PluginTargetCandidate,
  PluginTargetDelivery,
  PluginTargetKind,
  PluginTargetPickerPush,
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

interface Binding extends PluginTargetView {
  pluginId: string;
  targetId: string;
}
interface Receipt {
  pluginId: string;
  requestKey: string;
  hash: string;
  clientId: string;
  taskId?: string;
  status: 'pending' | 'accepted' | 'cancelled';
}
interface Ledger {
  bindings: Record<string, Binding>;
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
const ledger = createOverrideSettingsFile<Ledger>({
  filePath: () => ownerScopedUserDataPath('plugin-targets.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { bindings: {} },
  normalize: (raw) => {
    const value = raw as Ledger | null;
    return {
      bindings: value?.bindings && typeof value.bindings === 'object' ? value.bindings : {},
    };
  },
  log: desktopMakerLogger.child('plugin-targets'),
  label: 'plugin-targets',
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});
/** User selection is the grant. No plugin-supplied task ID or project path is accepted. */
export class PluginTargetSlot {
  adapter: PluginTargetAdapter | null = null;
  private temporary = new Map<string, Binding & { expiresAt: number; consumedBy?: string }>();
  private receipts = new Map<string, Receipt & { result?: Promise<unknown> }>();
  private operations = new Map<string, { cancelled: boolean; expiresAt: number }>();
  private activePicker = new Map<string, object>();
  private picks = new Map<
    string,
    {
      operation: string;
      pluginId: string;
      senderId: number;
      options: PluginTargetCandidate[];
      resolve: (id: string | null) => void;
      close: () => void;
    }
  >();
  constructor(
    private readonly ui: {
      open(payload: PluginTargetPickerPush): { senderId: number; close: () => void };
      name(pluginId: string): string;
      revision(pluginId: string): string | null;
    },
  ) {}
  private scope(pluginId: string, key: string) {
    return JSON.stringify([
      activeOwnerScopeKey(),
      getActiveDataOwnerPushStamp().ownerGeneration,
      pluginId,
      this.ui.revision(pluginId),
      key,
    ]);
  }
  private read() {
    ledger.invalidateIfChanged();
    return ledger.read();
  }
  private binding(pluginId: string, id: string): Binding {
    const binding = this.read().bindings[id];
    if (!binding || binding.pluginId !== pluginId || !kinds.includes(binding.kind))
      return fail('TARGET_UNAVAILABLE');
    return binding;
  }
  resolve(requestId: string, senderId: number, id: unknown): boolean {
    const pending = this.picks.get(requestId);
    if (!pending || pending.senderId !== senderId) return false;
    pending.resolve(
      typeof id === 'string' && pending.options.some((item) => item.id === id) ? id : null,
    );
    return true;
  }
  private cancelPick(operation: string) {
    for (const pending of this.picks.values())
      if (pending.operation === operation) pending.resolve(null);
  }
  async handle(pluginId: string, raw: unknown, authorized: () => void): Promise<unknown> {
    authorized();
    for (const [key, binding] of this.temporary)
      if (binding.expiresAt < Date.now()) this.temporary.delete(key);
    for (const [key, operation] of this.operations)
      if (operation.expiresAt < Date.now() && !this.receipts.has(key)) {
        this.operations.delete(key);
        this.receipts.delete(key);
      }
    if (!this.adapter) return fail('HOST_NOT_READY');
    const adapter = this.adapter;
    const request = raw as PluginTargetRequest;
    if (!request || !['pick', 'get', 'send', 'cancel'].includes(request.kind))
      return fail('INVALID_PARAMS');
    if (request.kind === 'get') {
      if (!keyString(request.bindingId)) return fail('INVALID_PARAMS');
      const binding = this.binding(pluginId, request.bindingId);
      const candidates = await adapter.candidates(binding.kind);
      authorized();
      const fresh = candidates.find((item) => item.id === binding.targetId);
      if (!fresh) return fail('TARGET_UNAVAILABLE');
      // Exchange a saved binding for a short-lived, one-use delivery handle.
      // A Host restart loses handles, so an uncertain send cannot replay after restart.
      const handle = {
        ...binding,
        bindingId: randomUUID(),
        label: fresh.label.slice(0, 200),
        expiresAt: Date.now() + 300000,
      };
      this.temporary.set(this.scope(pluginId, handle.bindingId), handle);
      return { bindingId: handle.bindingId, kind: handle.kind, label: handle.label };
    }
    if (!keyString(request.requestKey)) return fail('INVALID_PARAMS');
    const operationKey = this.scope(pluginId, request.requestKey);
    if (request.kind === 'cancel') {
      const operation = this.operations.get(operationKey) ?? {
        cancelled: true,
        expiresAt: Date.now() + 600000,
      };
      operation.cancelled = true;
      this.operations.set(operationKey, operation);
      this.cancelPick(operationKey);
      const receipt = this.receipts.get(operationKey);
      if (receipt?.taskId) {
        // Withdraw only this plugin input. Never stop another user's running turn.
        await adapter.withdraw(receipt.taskId, receipt.clientId, authorized);
        authorized();
      }
      this.receipts.delete(operationKey);
      return { cancelled: true, runningWorkMayHaveStarted: receipt?.status === 'accepted' };
    }
    let operation = this.operations.get(operationKey);
    if (!operation) {
      operation = { cancelled: false, expiresAt: Date.now() + 600000 };
      this.operations.set(operationKey, operation);
    }
    const guard = () => {
      authorized();
      if (operation!.cancelled) fail('SUPERSEDED');
    };
    guard();
    if (request.kind === 'pick') {
      if (
        !kinds.includes(request.targetKind) ||
        (request.persistent !== undefined && typeof request.persistent !== 'boolean')
      )
        return fail('INVALID_PARAMS');
      const marker = {};
      this.activePicker.set(pluginId, marker);
      const guardPicker = () => {
        guard();
        if (this.activePicker.get(pluginId) !== marker) fail('SUPERSEDED');
      };
      // A plugin gets at most one live picker; replacement also settles the old IPC.
      for (const pending of this.picks.values())
        if (pending.pluginId === pluginId) pending.resolve(null);
      const candidates = await adapter.candidates(request.targetKind);
      guardPicker();
      const requestId = randomUUID();
      const selected = await new Promise<string | null>((resolve, reject) => {
        let ui: { senderId: number; close: () => void };
        let timer: ReturnType<typeof setTimeout>;
        let boundaryTimer: ReturnType<typeof setInterval>;
        const finish = (id: string | null) => {
          clearTimeout(timer);
          clearInterval(boundaryTimer);
          this.picks.delete(requestId);
          ui?.close();
          resolve(id);
        };
        try {
          ui = this.ui.open({
            requestId,
            pluginName: this.ui.name(pluginId),
            kind: request.targetKind,
            persistent: request.persistent === true,
            candidates,
          });
          this.picks.set(requestId, {
            operation: operationKey,
            pluginId,
            senderId: ui.senderId,
            options: candidates,
            resolve: finish,
            close: ui.close,
          });
          timer = setTimeout(() => finish(null), 120000);
          boundaryTimer = setInterval(() => {
            try {
              guardPicker();
            } catch {
              finish(null);
            }
          }, 500);
        } catch (error) {
          reject(error);
        }
      });
      guardPicker();
      if (!selected) return { cancelled: true };
      const candidate = candidates.find((item) => item.id === selected)!;
      const binding: Binding = {
        pluginId,
        bindingId: randomUUID(),
        kind: request.targetKind,
        targetId: candidate.id,
        label: candidate.label.slice(0, 200),
      };
      if (request.persistent) {
        await ledger.updateAtomic(({ value }) => {
          guardPicker();
          return { bindings: { ...value.bindings, [binding.bindingId]: binding } };
        });
        guardPicker();
      } else
        this.temporary.set(this.scope(pluginId, binding.bindingId), {
          ...binding,
          expiresAt: Date.now() + 300000,
        });
      return { bindingId: binding.bindingId, kind: binding.kind, label: binding.label };
    }
    if (
      !keyString(request.bindingId) ||
      typeof request.text !== 'string' ||
      !request.text.trim() ||
      request.text.length > 64000 ||
      (request.delivery !== undefined && !['queue', 'steer'].includes(request.delivery)) ||
      (request.title !== undefined &&
        (typeof request.title !== 'string' || request.title.length > 200))
    )
      return fail('INVALID_PARAMS');
    // Saved IDs authorize resolution, not sending. Only a host-minted live handle sends.
    const binding = this.temporary.get(this.scope(pluginId, request.bindingId));
    if (!binding || binding.pluginId !== pluginId) return fail('TARGET_UNAVAILABLE');
    const delivery = request.delivery ?? 'queue';
    if (binding.kind === 'project' && delivery === 'steer') return fail('INVALID_PARAMS');
    if (request.route !== undefined) {
      const route = request.route;
      if (
        !route ||
        !['cc', 'codex', 'pi'].includes(route.agentKind) ||
        !keyString(route.providerId) ||
        typeof route.model !== 'string' ||
        !route.model.trim() ||
        route.model.length > 256 ||
        typeof route.effort !== 'string' ||
        route.effort.length > 32 ||
        typeof route.fastMode !== 'boolean'
      )
        return fail('INVALID_PARAMS');
    }
    if (binding.kind !== 'project' && request.route !== undefined) return fail('INVALID_PARAMS');
    const images = parsePluginMessageAttachments(request.attachments);
    const candidates = await adapter.candidates(binding.kind);
    guard();
    if (!candidates.some((item) => item.id === binding.targetId)) return fail('TARGET_UNAVAILABLE');
    const hash = createHash('sha256')
      .update(JSON.stringify([binding.bindingId, request.text, request.title, request.route, delivery,
        images.map(({ hash, name }) => [hash, name])]))
      .digest('hex');
    const receipt: Receipt = {
      pluginId,
      requestKey: request.requestKey,
      hash,
      clientId: randomUUID(),
      status: 'pending',
    };
    const previous = this.receipts.get(operationKey);
    if (previous) {
      if (previous.hash !== hash) return fail('REQUEST_KEY_CONFLICT');
      if (previous.result) return previous.result;
      return fail('DELIVERY_UNCERTAIN');
    }
    // A one-use handle cannot become a second delivery by changing text or requestKey.
    if (binding.consumedBy && binding.consumedBy !== operationKey)
      return fail('DELIVERY_UNCERTAIN');
    binding.consumedBy = operationKey;
    const saved: Receipt & { result?: Promise<unknown> } = receipt;
    this.receipts.set(operationKey, saved);
    const deliver = async () => {
      receipt.taskId =
        binding.kind === 'project'
          ? randomUUID()
          : await adapter.session(binding.kind, binding.targetId);
      guard();
      if (binding.kind === 'project')
        await adapter.create(
          pluginId,
          binding.targetId,
          receipt.taskId,
          request.title || binding.label,
          request.route,
          guard,
        );
      guard();
      const actualDelivery = await adapter.send(
        pluginId,
        receipt.taskId,
        receipt.clientId,
        request.text,
        guard,
        async () => {
          const fresh = await adapter.candidates(binding.kind);
          guard();
          if (!fresh.some((item) => item.id === binding.targetId)) fail('TARGET_UNAVAILABLE');
          if (
            binding.kind !== 'project' &&
            (await adapter.session(binding.kind, binding.targetId)) !== receipt.taskId
          )
            fail('TARGET_UNAVAILABLE');
          guard();
        },
        delivery,
        images,
      );
      receipt.status = 'accepted';
      authorized();
      if (operation.cancelled) await adapter.withdraw(receipt.taskId, receipt.clientId, authorized);
      return { taskId: receipt.taskId, accepted: true, delivery: actualDelivery };
    };
    saved.result = deliver().finally(() => {
      if (operation!.cancelled) this.receipts.delete(operationKey);
    });
    return saved.result;
  }
}
