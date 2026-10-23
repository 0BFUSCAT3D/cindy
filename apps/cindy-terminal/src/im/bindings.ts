import path from "node:path";
import type { Logger } from "@cindy/maker-core";
import {
  PersistentImBindingStore,
  imBindingKey,
  type ImBindingRow,
  type ImBindingStorage,
} from "@cindy/im-runtime/binding";
import { atomicPrivateWrite, readPrivateFile } from "../platform.js";

/** One atomic owner-scoped file implements the same takeover replacement and
 * recovery contract as Desktop's binding transaction. No credentials live here. */
export class TerminalImBindings {
  readonly store: PersistentImBindingStore;
  readonly ready: Promise<void>;
  private rows: ImBindingRow[] = [];
  private closed = false;
  private readonly file: string;

  constructor(
    private readonly options: {
      root: string;
      assertCurrent(): void;
      logger: Logger;
    },
  ) {
    this.file = path.join(options.root, "channel-bindings.json");
    this.store = new PersistentImBindingStore({
      log: options.logger,
      captureStorage: () => this.captureStorage(),
    });
    this.ready = this.open();
  }

  private guard() {
    if (this.closed) throw new Error("IM_BINDINGS_CLOSED");
    this.options.assertCurrent();
  }

  private async open() {
    this.guard();
    const raw = await readPrivateFile(this.file);
    this.guard();
    if (raw) {
      const parsed: unknown = JSON.parse(raw.toString());
      if (!Array.isArray(parsed)) throw new Error("INVALID_IM_BINDINGS");
      this.rows = parsed.map(validateRow);
      if (new Set(this.rows.map(imBindingKey)).size !== this.rows.length)
        throw new Error("DUPLICATE_IM_BINDING_IDENTITY");
    }
    await this.store.preload();
  }

  private captureStorage(): ImBindingStorage {
    this.guard();
    const commit = async (rows: ImBindingRow[]) => {
      this.guard();
      await atomicPrivateWrite(this.file, JSON.stringify(rows));
      this.guard();
      this.rows = rows;
    };
    return {
      list: async () => {
        this.guard();
        return structuredClone(this.rows);
      },
      replace: async (input) => {
        const row = validateRow(input),
          key = imBindingKey(row);
        await commit([
          ...this.rows.filter(
            (candidate) =>
              imBindingKey(candidate) !== key &&
              candidate.targetSessionId !== row.targetSessionId,
          ),
          row,
        ]);
      },
      deleteTarget: async (id) => {
        await commit(this.rows.filter((row) => row.targetSessionId !== id));
      },
      deleteIdentities: async (identities) => {
        const keys = new Set(identities.map(imBindingKey));
        await commit(this.rows.filter((row) => !keys.has(imBindingKey(row))));
      },
    };
  }

  async close() {
    this.closed = true;
    await this.ready.catch(() => {});
    await this.store.flush();
    this.store.resetRuntime();
  }
}

function validateRow(input: unknown): ImBindingRow {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_IM_BINDING");
  const row = input as Record<string, unknown>;
  const identifier = (value: unknown, empty = false): value is string =>
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= 512 &&
    !value.includes("\0");
  if (
    !identifier(row.channel) ||
    !/^[a-z][a-z-]{0,31}$/.test(row.channel) ||
    !identifier(row.botContextId) ||
    !identifier(row.userId) ||
    !identifier(row.scopeKey, true) ||
    typeof row.targetSessionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(row.targetSessionId) ||
    typeof row.attachedAt !== "number" ||
    !Number.isSafeInteger(row.attachedAt) ||
    row.attachedAt < 0 ||
    (row.attachedViaCardMessageId !== null &&
      !identifier(row.attachedViaCardMessageId))
  )
    throw new Error("INVALID_IM_BINDING");
  return {
    channel: row.channel,
    botContextId: row.botContextId,
    userId: row.userId,
    scopeKey: row.scopeKey,
    targetSessionId: row.targetSessionId,
    attachedAt: row.attachedAt,
    attachedViaCardMessageId: row.attachedViaCardMessageId as string | null,
  };
}
