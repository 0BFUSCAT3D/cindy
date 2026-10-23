import { GhostManager, type GhostManagerOptions } from './store/ghostManager.js';
import { GhostNodeRuntimeBroker, type GhostNodeRuntimeBrokerDeps } from './nodeRuntimeBroker.js';
import { createNativeNodeWorkerProcess, type NativeNodeWorkerOptions } from './nativeProcess.js';
import { createNativeSnapshotMutation } from './nativeSnapshot.js';
import { bindDeviceAuthorizationTarget, bindPluginAuthorizationTarget } from './authorization/targetPolicy.js';
import { ghostInstallApprovalToken, type GhostManifest, type InstalledGhost } from './shared/ghost.js';
import { installedGhostStoragePart } from './shared/pluginIdentity.js';

export interface NativePluginHostOptions {
  manager: GhostManagerOptions;
  node: NativeNodeWorkerOptions & { snapshotWorkerPath: string };
  broker: Omit<GhostNodeRuntimeBrokerDeps, 'getGhost' | 'instanceId' | 'spawnProcess' | 'spawnChildProcess' | 'bindDeviceAuthorizationTarget' | 'bindPluginAuthorizationTarget'>;
}

/** Shared installed/approved store and published Node ABI, without Electron.
 * The web logic/panel runtime remains a distinct required host adapter. This
 * class never substitutes direct Node RPC for a plugin's main.js tool logic. */
export class NativePluginHost {
  readonly manager: GhostManager;
  readonly node: GhostNodeRuntimeBroker;
  private installed = new Map<string, InstalledGhost>();
  private refreshTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: NativePluginHostOptions) {
    this.manager = new GhostManager({ ...options.manager,
      mutateSnapshot: options.manager.mutateSnapshot ?? createNativeSnapshotMutation({ nodePath: options.node.nodePath, workerPath: options.node.snapshotWorkerPath }),
      onChanged: ghosts => { options.manager.onChanged?.(ghosts); void this.refresh().catch(error => options.manager.log?.warn('plugin runtime refresh failed', { code: error instanceof Error ? error.name : 'Error' })); },
    });
    const spawnProcess = (entry: string, cwd: string, id: string, args?: string[]) => createNativeNodeWorkerProcess(options.node, entry, cwd, id, args);
    this.node = new GhostNodeRuntimeBroker({ ...options.broker,
      instanceId: installedGhostStoragePart,
      getGhost: id => this.closed ? null : this.installed.get(id) ?? null,
      spawnProcess, spawnChildProcess: spawnProcess,
      bindDeviceAuthorizationTarget: (manifest, url) => { const assertTarget = bindDeviceAuthorizationTarget(manifest as GhostManifest, url); return current => assertTarget(current as GhostManifest); },
      bindPluginAuthorizationTarget: (manifest, request) => { const assertTarget = bindPluginAuthorizationTarget(manifest as GhostManifest, request); return current => assertTarget(current as GhostManifest); },
    });
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    await this.manager.migrateLegacyApprovalsOnce();
    await this.refresh();
  }

  list(): InstalledGhost[] { return [...this.installed.values()].map(ghost => structuredClone(ghost)); }

  refresh(): Promise<void> {
    const next = this.refreshTail.catch(() => {}).then(async () => {
      if (this.closed) return;
      const ghosts = await this.manager.listAsync();
      if (this.closed) return;
      const current = new Map(ghosts.map(ghost => [installedGhostStoragePart(ghost), ghost]));
      for (const [id, previous] of this.installed) {
        const replacement = current.get(id);
        if (!replacement?.enabled || ghostInstallApprovalToken(previous.approval) !== ghostInstallApprovalToken(replacement.approval) || previous.dir !== replacement.dir) await this.node.stopAndWait(id);
      }
      if (this.closed) return;
      this.installed = current;
      for (const ghost of ghosts) {
        if (this.closed) return;
        if (ghost.enabled && ghost.approval?.state === 'approved' && ghost.manifest.node?.lifecycle === 'resident') await this.node.startResident(ghost);
      }
    });
    this.refreshTail = next;
    return next;
  }

  /** Wire only to the existing authenticated logic-page node-request pipe. */
  async handleNodeRequest(instanceId: string, payload: unknown) {
    await this.refreshTail;
    if (this.closed) throw new Error('PLUGIN_HOST_CLOSED');
    return this.node.handleRequest(instanceId, payload);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Clear lookup authority before awaiting pending work or process teardown.
    const ids = [...this.installed.keys()]; this.installed.clear();
    await this.refreshTail.catch(() => {});
    for (const id of ids) await this.node.stopAndWait(id);
    this.node.destroyAll();
  }
}
