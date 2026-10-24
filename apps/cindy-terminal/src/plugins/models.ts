import path from 'node:path';
import { createOneshotTextHandler } from '@cindy/plugin-runtime/oneshotText';
import { normalize, type PluginTaskConfig } from '@cindy/plugin-runtime/pluginTaskConfig';
import { ghostInstallApprovalToken, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { decodeCatalogModelPin, encodeCatalogModelPin } from '@cindy/model-providers/catalogModelPin';
import { resolveOneshotCatalogModel } from '@cindy/model-providers/utility-model/textOneshotPinOptions';
import type { TerminalModelConfig } from '../models/config.js';
import type { TerminalUtilityModels } from '../models/utility.js';
import { atomicPrivateWrite, readPrivateFile } from '../platform.js';

function selection(config: PluginTaskConfig): string | null {
  if (!config.model) return null;
  if (config.providerId && (config.agentKind === 'cc' || config.agentKind === 'codex'))
    return encodeCatalogModelPin({ providerId: config.providerId, agentKind: config.agentKind === 'cc' ? 'claude-code' : config.agentKind, model: config.model });
  return `saved:${JSON.stringify([config.providerId ?? null, config.agentKind ?? null, config.model])}`;
}

/** Uses the installed plugin's existing model preference and capability ABI.
 * Credentials and paid dispatch remain behind the owner's auxiliary runtime. */
export class TerminalPluginModels {
  private readonly inflight = new Map<string, number>();
  private writes: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private readonly work = new Set<Promise<unknown>>();
  constructor(private readonly options: {
    root: string;
    models: TerminalModelConfig;
    utility: TerminalUtilityModels;
    installed(id: string): InstalledGhost | null;
    guard(): void;
    changed(): void;
  }) {}
  private guard() {
    if (this.abort.signal.aborted) throw new Error('PLUGIN_HOST_CLOSED');
    this.options.guard();
  }
  private queue<T>(fn: () => Promise<T>) {
    const result = this.writes.then(() => { this.guard(); return fn(); });
    this.writes = result.catch(() => {});
    return result;
  }
  private async read() {
    const file = path.join(this.options.root, 'ghost-errand-prefs.json');
    const legacyFile = path.join(this.options.root, 'ghost-cindy-prefs.json');
    const [bytes, legacyBytes] = await Promise.all([readPrivateFile(file), readPrivateFile(legacyFile)]);
    this.guard();
    const prefs = normalize(bytes ? JSON.parse(bytes.toString()) : {});
    const legacy = legacyBytes ? JSON.parse(legacyBytes.toString()) as Record<string, unknown> : {};
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('PLUGIN_PREFERENCES_INVALID');
    if (legacy.overrides && typeof legacy.overrides === 'object') {
      for (const [id, value] of Object.entries(legacy.overrides)) {
        const pin = value && typeof value === 'object' ? (value as Record<string, unknown>)['text.oneshot'] : null;
        const route = typeof pin === 'string' ? decodeCatalogModelPin(pin) : null;
        if (route && !prefs.errand[id]?.model) prefs.errand[id] = {
          ...prefs.errand[id], ...route, agentKind: route.agentKind === 'claude-code' ? 'cc' : route.agentKind,
        };
      }
      this.guard();
      // Publish the new preference first. If interrupted, the old pin can be
      // read again without replacing an already migrated/user-chosen model.
      await atomicPrivateWrite(file, JSON.stringify(prefs));
      this.guard(); delete legacy.overrides;
      await atomicPrivateWrite(legacyFile, JSON.stringify(legacy));
      this.guard();
    }
    return { prefs, legacy, file };
  }
  config(id: string): Promise<PluginTaskConfig> {
    return this.queue(async () => structuredClone((await this.read()).prefs.errand[id] ?? {}));
  }
  async state(id: string) {
    const config = await this.config(id);
    const state = await this.options.utility.state();
    this.guard();
    return { config, selected: selection(config), options: state.options.filter(option => !option.budget && option.available) };
  }
  async setModel(id: string, pin: unknown, current: () => void = () => {}) {
    if (pin !== null && typeof pin !== 'string') throw new Error('INVALID_MODEL_SELECTION');
    await this.queue(async () => {
      current();
      const ghost = this.options.installed(id);
      if (!ghost) throw new Error('PLUGIN_NOT_FOUND');
      const approval = ghostInstallApprovalToken(ghost.approval);
      const { prefs, file } = await this.read();
      if (pin === selection(prefs.errand[id] ?? {})) return;
      if (pin !== null && !(await this.options.utility.state()).options.some(option => !option.budget && option.available && option.id === pin)) throw new Error('MODEL_ROUTE_UNAVAILABLE');
      const { model: _model, providerId: _provider, agentKind: _agent, effort: _effort, fastMode: _fast, ...rest } = prefs.errand[id] ?? {};
      const route = typeof pin === 'string' ? decodeCatalogModelPin(pin) : null;
      if (pin !== null && !route) throw new Error('INVALID_MODEL_SELECTION');
      const next: PluginTaskConfig = route ? { ...rest, ...route, agentKind: route.agentKind === 'claude-code' ? 'cc' : route.agentKind } : rest;
      if (Object.keys(next).length) prefs.errand[id] = next;
      else delete prefs.errand[id];
      this.guard(); current();
      const latest = this.options.installed(id);
      if (!latest || latest.dir !== ghost.dir || ghostInstallApprovalToken(latest.approval) !== approval) throw new Error('PLUGIN_CHANGED');
      await atomicPrivateWrite(file, JSON.stringify(prefs));
      this.guard(); current(); this.options.changed();
    });
  }
  receive(id: string, payload: unknown) {
    const operation = this.handle(id, payload).catch(() => ({ ok: false, errorCode: 'INTERNAL', message: 'The model request could not be completed.' }));
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation)).catch(() => {});
    return operation;
  }
  private async handle(id: string, payload: unknown) {
    this.guard();
    const initial = this.options.installed(id);
    if (!initial?.enabled || initial.approval?.state !== 'approved' || !initial.manifest.cindy?.text?.includes('oneshot')) return { ok: false, errorCode: 'PERMISSION_DENIED' };
    const approval = ghostInstallApprovalToken(initial.approval);
    const current = () => {
      this.guard(); const ghost = this.options.installed(id);
      if (!ghost?.enabled || ghost.dir !== initial.dir || ghost.approval?.state !== 'approved' || ghostInstallApprovalToken(ghost.approval) !== approval) throw new Error('PLUGIN_CHANGED');
      return ghost;
    };
    const [{ prefs, legacy }, views] = await Promise.all([this.queue(() => this.read()), this.options.models.views()]);
    current();
    const config = prefs.errand[id] ?? {};
    const limits = legacy.inflightLimits as Record<string, unknown> | undefined;
    const limit = limits?.[id];
    const handler = createOneshotTextHandler({
      getGhost: () => current(),
      getInflightLimit: () => typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 ? limit : null,
      getOneshotModelSelection: () => config.model && config.agentKind ? { model: config.model, providerId: config.providerId, agentKind: config.agentKind === 'cc' ? 'claude-code' : config.agentKind } : null,
      resolveOneshotModel: model => resolveOneshotCatalogModel(this.options.models.activeCatalog(), this.options.models.snapshot().disabled, model, undefined,
        provider => views.some(view => view.id === provider.id && view.connected)),
      oneshotText: async ({ prompt, maxTokens, timeoutMs, route }) => {
        current();
        const result = await this.options.utility.request(prompt, { maxTokens, timeoutMs,
          ...(route ? { providerId: route.providerId, agentKind: route.agentKind, model: route.model } : {}),
          signal: this.abort.signal,
          beforeDispatch: async () => { current(); const next = await this.config(id); current(); return JSON.stringify(next) === JSON.stringify(config); },
        });
        current();
        if (result.ok) return { ok: true, text: result.text, model: `${result.providerId}/${result.model}` };
        const reason = result.reason === 'no_candidate' || result.reason === 'timeout' ? result.reason : 'failed';
        return { ok: false, reason, message: reason === 'no_candidate' ? 'No connected auxiliary model is available.' : reason === 'timeout' ? 'The model request timed out.' : 'The model request failed.' };
      },
    }, this.inflight);
    try { const result = await handler(id, payload); current(); return result; }
    catch { return { ok: false, errorCode: 'INTERNAL', message: 'The model request could not be completed.' }; }
  }
  async relocate(from: string, to: string) {
    await this.queue(async () => {
      const { prefs, legacy, file } = await this.read();
      if (prefs.errand[from]) { prefs.errand[to] = prefs.errand[from]; delete prefs.errand[from]; }
      for (const key of Object.keys(prefs.sessions)) if (key === from || key.startsWith(`${from}#`)) {
        prefs.sessions[to + key.slice(from.length)] = prefs.sessions[key]; delete prefs.sessions[key];
      }
      await atomicPrivateWrite(file, JSON.stringify(prefs)); this.guard();
      const limits = legacy.inflightLimits as Record<string, unknown> | undefined;
      if (limits && Object.hasOwn(limits, from)) { limits[to] = limits[from]; delete limits[from];
        await atomicPrivateWrite(path.join(this.options.root, 'ghost-cindy-prefs.json'), JSON.stringify(legacy)); this.guard(); }
    });
  }
  async close() { this.abort.abort(); await Promise.allSettled([this.writes, ...this.work]); }
}
