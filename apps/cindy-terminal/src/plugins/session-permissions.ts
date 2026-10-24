import { randomUUID } from "node:crypto";
import type { Session } from "@cindy/maker-core";
import { requestHostInteraction } from "@cindy/im-runtime/interactionRouter";
import type { HostPermissionRequester } from "@cindy/plugin-runtime/ghostInstallConsentInteraction";
import type {
  GhostGrantConfirmPayload,
  GhostGrantConfirmDecision,
} from "@cindy/plugin-runtime/grantTypes";
import type { PluginTaskContext } from "./permissions.js";

/** Tasks and companions use the same live permission generations and host UI. */
export function createPluginSessionPermissions(host: {
  session(id: string): Session | undefined;
  workingDir(id: string): Promise<string | null>;
}) {
  const request: HostPermissionRequester = async (
    id,
    instance,
    input,
    signal,
  ) => {
    const session = host.session(id);
    if (!session || session.instanceId !== instance) return null;
    const result = await requestHostInteraction(
      session,
      input,
      signal ?? new AbortController().signal,
    );
    return host.session(id) === session ? result : null;
  };
  return {
    request,
    async snapshot(
      id: string,
      instance?: string,
    ): ReturnType<PluginTaskContext["snapshot"]> {
      const session = host.session(id);
      if (!session || (instance && session.instanceId !== instance))
        return null;
      const permission = session.stablePermissionModeState,
        plan = session.stablePlanModeState;
      if (!permission?.mode || !plan) return null;
      const workingDir = await host.workingDir(id);
      const isCurrent = () =>
        host.session(id) === session &&
        session.stablePermissionModeState?.generation ===
          permission.generation &&
        session.stablePlanModeState?.generation === plan.generation;
      if (!workingDir || !isCurrent()) return null;
      return {
        workingDir,
        permissionMode: permission.mode,
        planModeEnabled: plan.enabled,
        remoteHostId: null,
        autoReviewOwner: session.autoReviewOwner,
        isCurrent,
        reviewAction: (action) => session.reviewHostPermissionAction(action),
      };
    },
    async confirm(
      id: string,
      payload: GhostGrantConfirmPayload,
      signal?: AbortSignal,
    ): Promise<GhostGrantConfirmDecision> {
      const session = host.session(id);
      if (!session) return { confirmed: false, reason: "session_closed" };
      const result = await request(
        id,
        session.instanceId,
        {
          kind: "permission",
          requestId: randomUUID(),
          toolName: "cindy.plugin.write",
          input: payload as unknown as Record<string, unknown>,
        },
        signal ?? new AbortController().signal,
      );
      return result?.kind === "permission" && result.behavior === "allow"
        ? { confirmed: true }
        : { confirmed: false, reason: "cancelled" };
    },
  };
}
