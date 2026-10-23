import path from 'node:path';
import { createRequire } from 'node:module';
import { lstat } from 'node:fs/promises';
import { LibraryBindingStore, relocateLibraryMetaOwner } from '@cindy/plugin-runtime/library/libraryBinding';
import { LibraryVault, statfsFreeBytes } from '@cindy/plugin-runtime/library/libraryVault';
import { LibrarySqlService } from '@cindy/plugin-runtime/library/librarySqlService';
import { GhostLibrarySlot, type GhostLibrarySlotDeps } from '@cindy/plugin-runtime/library/librarySlot';
import { relocateLibraryStagingOwner } from '@cindy/plugin-runtime/library/libraryStaging';

const require = createRequire(import.meta.url);

/** The shared Library slot owns file/SQL/staging validation. The terminal host
 * supplies an owner root and a Node ABI worker, never a renderer or display. */
export class TerminalPluginLibrary {
  readonly bindings: LibraryBindingStore;
  readonly slot: GhostLibrarySlot;
  constructor(private readonly options: {
    root: string;
    runtimeDirectory: string;
    getGhost: GhostLibrarySlotDeps['getGhost'];
    current(): boolean;
    log?: GhostLibrarySlotDeps['log'];
    syncAgentReadonlyExtraDir?: GhostLibrarySlotDeps['syncAgentReadonlyExtraDir'];
  }) {
    this.bindings = new LibraryBindingStore({
      getFile: () => path.join(options.root, 'libraries-binding.json'),
      getManagedRoots: () => [path.resolve(options.root, '../..')],
      getDefaultRoot: id => this.root(id), log: options.log,
    });
    this.slot = new GhostLibrarySlot({
      getGhost: id => options.current() ? options.getGhost(id) : null,
      bindingStore: this.bindings,
      getDefaultRoot: id => this.root(id),
      getStagingRoot: id => path.join(options.root, 'library-staging', id),
      captureOwnerScope: () => options.current() ? options.root : null,
      createVault: deps => new LibraryVault(deps),
      createSqlService: deps => new LibrarySqlService(deps),
      getDiskFreeBytes: statfsFreeBytes,
      workerScriptPath: () => path.join(options.runtimeDirectory, 'plugin-library-worker.mjs'),
      betterSqliteModulePath: () => require.resolve('better-sqlite3'),
      syncAgentReadonlyExtraDir: options.syncAgentReadonlyExtraDir,
      log: options.log,
    });
  }
  root(id: string) { return path.join(this.options.root, 'libraries', id); }

  /** Called inside the existing durable source archive transaction, after its
   * physical rename. Each shared relocation helper is restart/rollback safe. */
  async archive(from: string, to: string, assertCurrent: () => void) {
    assertCurrent();
    await this.bindings.relocateBinding(from, to);
    assertCurrent();
    await relocateLibraryMetaOwner(this.root(to), from, to, assertCurrent);
    await relocateLibraryStagingOwner(path.join(this.options.root, 'library-staging', to), from, to, this.options.root, assertCurrent);
    assertCurrent();
  }

  /** Mark an existing library only. Uninstall must neither create an empty
   * replacement for a missing disk nor delete any of the user's works. */
  async orphan(id: string, name: string) {
    const location = await this.bindings.resolveLibraryRoot(id);
    if (!location.root) return;
    const meta = await lstat(path.join(location.root, '.cindy-library', 'meta.json')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!meta?.isFile()) return;
    const vault = new LibraryVault({
      rootDir: () => location.root!, ghostId: id, locationKind: location.kind,
      ...(location.kind === 'custom' ? {
        customParentGrant: { realPathAtGrant: location.record.realPathAtGrant, identity: location.record.identity },
        allowCustomInit: false,
      } : {}), log: this.options.log,
    });
    try {
      const opened = await vault.open();
      if (!opened.ok || opened.state === 'unavailable') throw new Error('PLUGIN_LIBRARY_UNAVAILABLE');
      const failure = await vault.markOrphaned(name);
      if (failure) throw new Error(failure.errorCode);
    } finally { await vault.invalidate(); }
  }
  close() { return this.slot.disposeAll(); }
}
