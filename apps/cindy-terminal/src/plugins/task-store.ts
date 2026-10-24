import { createPluginTargetStore } from '@cindy/plugin-runtime/pluginTargetStore';
import type { PluginTargetStore } from '@cindy/plugin-runtime/pluginTargetSlot';
import path from "node:path";
import { chmod, lstat } from "node:fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq } from "drizzle-orm";
import * as schema from "@cindy/plugin-runtime/pluginTaskSchema";
import {
  createPluginTaskStore,
  type PluginTaskDb,
} from "@cindy/plugin-runtime/pluginTaskStore";
import type { PluginTaskStore } from "@cindy/plugin-runtime/pluginTaskService";
import { privateDirectory } from "../platform.js";

/** Receipts outlive installs and native processes. Reinstall never reclaims old
 * task authority; the shared store retains revoked identities and request keys. */
export class TerminalPluginTaskStore {
  readonly ready: Promise<void>;
  private database?: Database.Database;
  private store?: PluginTaskStore;
  private targetStore?: PluginTargetStore;
  private closed = false;
  private mutationVersion = 0;
  revision() {
    return this.mutationVersion;
  }
  constructor(
    private readonly options: {
      root: string;
      guard(): void;
      sessionExists(id: string): Promise<boolean>;
    },
  ) {
    this.ready = this.open();
  }
  private guard() {
    if (this.closed) throw new Error("PLUGIN_TASK_STORE_CLOSED");
    this.options.guard();
  }
  private async open() {
    const directory = path.join(this.options.root, "plugin-tasks");
    await privateDirectory(directory);
    this.guard();
    const file = path.join(directory, "receipts.sqlite");
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      const info = await lstat(candidate).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (
        info &&
        (!info.isFile() ||
          info.isSymbolicLink() ||
          (process.platform !== "win32" &&
            typeof process.getuid === "function" &&
            info.uid !== process.getuid()))
      )
        throw new Error("UNSAFE_PLUGIN_TASK_DATABASE");
    }
    this.guard();
    const database = new Database(file);
    try {
      database.pragma("journal_mode = WAL");
      const version = database.pragma("user_version", { simple: true });
      if (version === 0)
        database.transaction(() => {
          database.exec(`CREATE TABLE plugin_task_requests (
          id TEXT PRIMARY KEY NOT NULL, plugin_id TEXT NOT NULL,
          operation TEXT NOT NULL, target_id TEXT NOT NULL, request_key TEXT NOT NULL,
          fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX plugin_task_request_key ON plugin_task_requests(plugin_id, operation, target_id, request_key);
        CREATE INDEX plugin_task_target ON plugin_task_requests(target_id, plugin_id);`);
          database.pragma("user_version = 1");
        })();
      else if (version !== 1)
        throw new Error("PLUGIN_TASK_DATABASE_VERSION_UNSUPPORTED");
      if (process.platform !== "win32") await chmod(file, 0o600);
      this.guard();
      const db: PluginTaskDb = drizzle(database, { schema });
      this.targetStore = createPluginTargetStore({ drizzle: db }, () => this.guard());
      this.store = createPluginTaskStore({ drizzle: db }, async (row) => {
        // The service calls this only before Session persistence ever started.
        // Still retain changed/revoked receipts and any existing Session row.
        if (await this.options.sessionExists(row.id)) return;
        this.guard();
        const table = schema.pluginTaskRequests;
        await db
          .delete(table)
          .where(
            and(
              eq(table.id, row.id),
              eq(table.pluginId, row.pluginId),
              eq(table.operation, "create"),
              eq(table.revision, row.revision),
            ),
          );
      });
      for (const key of [
        "insert",
        "save",
        "revokePlugin",
        "relocatePlugin",
        "discardUncreated",
      ] as const) {
        const mutate = this.store[key] as (...args: unknown[]) => Promise<void>;
        Object.assign(this.store, {
          [key]: async (...args: unknown[]) => {
            this.mutationVersion++;
            try {
              await mutate(...args);
            } finally {
              this.mutationVersion++;
            }
          },
        });
      }
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  async get(): Promise<PluginTaskStore> {
    await this.ready;
    this.guard();
    return this.store!;
  }
  async targets(): Promise<PluginTargetStore> { await this.ready; this.guard(); return this.targetStore!; }
  /** The owning service must drain accepted receipt writes before closing. */
  async close() {
    this.closed = true;
    await this.ready.catch(() => {});
    this.database?.close();
    this.database = undefined;
  }
}
