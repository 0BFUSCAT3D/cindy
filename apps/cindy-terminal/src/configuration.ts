import { randomUUID } from "node:crypto";
import {
  PLUGIN_SETTINGS_ACTION,
  type PluginOauthAction,
  type PluginSettingsRequest,
} from "@cindy/device-link";
import type { OauthCardBinding } from "@cindy/plugin-runtime/authorization/transactions";
import type { InvocationContext, TerminalClient } from "./contracts.js";
import type { TerminalCapabilities } from "./tasks/capabilities.js";

// Host-owned settings use the same authenticated exchange as input handoff and
// plugin settings. This identifier cannot be supplied by a plugin or a client.
export const CONFIGURATION_ID = "__cindy_configuration__";
const LIFETIME_MS = 5 * 60_000;
type Operation = {
  collectionId: "mcp";
  actionId: "create" | "edit";
  resourceId?: string;
};
type Lease = {
  operation: Operation;
  context: InvocationContext;
  revision: number;
  expiresAt: number;
  state: "open" | "saving" | "saved" | "failed";
};

export function configurationOperation(raw: unknown): Operation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("INVALID_CONFIGURATION");
  const value = raw as Record<string, unknown>;
  if (
    value.collectionId !== "mcp" ||
    !["create", "edit"].includes(String(value.actionId)) ||
    (value.resourceId !== undefined &&
      (typeof value.resourceId !== "string" ||
        !value.resourceId ||
        value.resourceId.length > 256)) ||
    (value.actionId === "edit" && !value.resourceId) ||
    (value.actionId === "create" && value.resourceId !== undefined)
  )
    throw new Error("INVALID_CONFIGURATION");
  return {
    collectionId: "mcp",
    actionId: value.actionId as Operation["actionId"],
    ...(value.resourceId ? { resourceId: value.resourceId as string } : {}),
  };
}

/** A lease authorizes one configuration mutation on one host and controller.
 * No configuration values are included in the generic resource request. */
export class TerminalConfiguration {
  private readonly leases = new Map<string, Lease>();
  private closed = false;
  constructor(private readonly capabilities: TerminalCapabilities) {}

  open(raw: unknown, context: InvocationContext) {
    if (this.closed || context.sharedTask) throw new Error("OWNER_REQUIRED");
    context.assertCurrent?.();
    for (const [id, lease] of this.leases)
      if (lease.expiresAt <= Date.now()) this.leases.delete(id);
    if (this.leases.size >= 64) throw new Error("CONFIGURATION_BUSY");
    const operation = configurationOperation(raw),
      id = randomUUID();
    this.leases.set(id, {
      operation,
      context,
      revision: this.capabilities.revision(),
      expiresAt: Date.now() + LIFETIME_MS,
      state: "open",
    });
    return { id, configurationId: CONFIGURATION_ID };
  }

  private current(lease: Lease) {
    if (this.closed || lease.expiresAt <= Date.now()) return false;
    try {
      this.capabilities.guard();
      lease.context.assertCurrent?.();
    } catch {
      return false;
    }
    return (
      lease.state === "saved" ||
      lease.state === "failed" ||
      lease.revision === this.capabilities.revision()
    );
  }

  bind(action: PluginOauthAction): OauthCardBinding | null {
    const lease = this.leases.get(action.requestId);
    if (
      !lease ||
      action.actionId !== PLUGIN_SETTINGS_ACTION ||
      action.expectedRevision !== 0 ||
      !this.current(lease)
    )
      return null;
    return {
      ghostId: CONFIGURATION_ID,
      settingsPage: true,
      controllerDeviceId: lease.context.deviceId ?? "terminal-local",
      current: () => this.current(lease),
    };
  }

  owns(id: string) {
    return this.leases.has(id);
  }

  async request(peer: string, request: PluginSettingsRequest) {
    const lease = this.leases.get(request.id);
    if (
      !lease ||
      peer !== (lease.context.deviceId ?? "terminal-local") ||
      !this.current(lease)
    )
      throw new Error("CONFIGURATION_STALE");
    const command = request.command;
    if (command.kind === "close") {
      // The authenticated envelope still needs to seal its final response.
      this.leases.delete(request.id);
      return { status: 204 };
    }
    if (
      command.kind !== "fetch" ||
      command.path !== "/configuration" ||
      command.method !== "PUT" ||
      typeof command.body !== "string" ||
      lease.state !== "open"
    )
      throw new Error("INVALID_CONFIGURATION");
    lease.state = "saving";
    try {
      await this.save(lease.operation, JSON.parse(command.body), {
        ...lease.context,
        assertCurrent: () => {
          if (!this.current(lease)) throw new Error("CONFIGURATION_STALE");
        },
      });
      lease.state = "saved";
      return { status: 204 };
    } catch {
      lease.state = "failed";
      // Never serialize validation failures that might quote submitted values.
      return { status: 400, code: "CONFIGURATION_SAVE_FAILED" };
    }
  }

  async save(operation: Operation, input: unknown, context: InvocationContext) {
    if (this.closed || context.sharedTask) throw new Error("OWNER_REQUIRED");
    context.assertCurrent?.();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("INVALID_CONFIGURATION");
    const value = input as Record<string, unknown>;
    const config = {
      ...value,
      ...(operation.resourceId ? { id: operation.resourceId } : {}),
    };
    await this.capabilities.configureMcp(operation.actionId, config, context);
  }

  close() {
    this.closed = true;
    this.leases.clear();
  }
}

export async function submitConfiguration(
  client: TerminalClient,
  operation: Operation,
  input: unknown,
  deviceId?: string,
): Promise<import("@cindy/device-link").RemoteActionInvokeResponse> {
  await client.invoke("terminal:configuration", [
    { ...operation, input, ...(deviceId ? { deviceId } : {}) },
  ]);
  return {
    effects: [
      {
        kind: "refresh-collection" as const,
        collectionId: operation.collectionId,
      },
    ],
  };
}
