import path from "node:path";
import type { AgentKind } from "@cindy/maker-core";
import type { XdtHelperMcpDeps } from "../../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js";
import type { TerminalCapabilities } from "../../tasks/capabilities.js";
import {
  companionCapabilities,
  type TerminalCompanionProfiles,
} from "./profiles.js";

/** References belong to this Profile; shared installations and secrets stay owned
 * by the account. A stale model tool cannot overwrite another saved selection. */
export function companionCapabilityCallbacks(options: {
  botId: string;
  sessionId: string;
  agentKind: AgentKind;
  profiles: TerminalCompanionProfiles;
  capabilities: TerminalCapabilities;
  current(): Promise<void>;
  changed(): void;
}): NonNullable<XdtHelperMcpDeps["botCapabilities"]> {
  type Kind = "skill" | "mcp" | "toolset";
  type Entry = {
    id: string;
    name: string;
    description: string;
    available: boolean;
    joined: boolean;
  };
  const profile = async (caller: string) => {
    if (caller !== options.sessionId)
      throw new Error("COMPANION_SCOPE_MISMATCH");
    await options.current();
    const row = await options.profiles.get(options.botId);
    await options.current();
    if (!row || row.status !== "active") throw new Error("COMPANION_NOT_FOUND");
    return row;
  };
  const catalog = async (caller: string, kind: Kind) => {
    const row = await profile(caller),
      config = companionCapabilities(row.capabilities),
      directory = path.join(options.profiles.home(row.id), "workspace");
    let entries: Entry[] = [];
    if (kind === "skill") {
      const result = await options.capabilities.listSkills(
        [directory],
        options.agentKind,
      );
      // Scanner errors are not evidence that a previously selected Skill vanished.
      if (result.errors.length)
        throw new Error("CAPABILITY_CATALOG_UNAVAILABLE");
      entries = result.items.map((item) => ({
        id: item.name,
        name: item.name,
        description: item.description ?? "",
        available: item.enabled !== false,
        joined: config.skills.includes(item.name),
      }));
    } else if (kind === "mcp")
      entries = (await options.capabilities.mcpEntries(directory)).map(
        (item) => ({
          id: item.id,
          name: item.name,
          description: "",
          available: item.enabled,
          joined:
            config.mcpMode === "inherit"
              ? item.enabled
              : config.mcpServers.includes(item.id),
        }),
      );
    for (const id of kind === "skill"
      ? config.skills
      : kind === "mcp"
        ? config.mcpServers
        : [])
      if (!entries.some((item) => item.id === id))
        entries.push({
          id,
          name: id,
          description: "",
          available: false,
          joined: true,
        });
    await options.current();
    return {
      row,
      config,
      entries: entries.filter(
        (entry, index, all) =>
          all.findIndex((item) => item.id === entry.id) === index,
      ),
    };
  };
  return {
    list: async (input) => {
      const { entries } = await catalog(input.callerSessionId, input.kind);
      return {
        ok: true,
        capabilities: input.query
          ? entries.filter((item) =>
              `${item.name} ${item.description}`
                .toLowerCase()
                .includes(input.query!.toLowerCase()),
            )
          : entries,
      };
    },
    select: async (input) => {
      const { row, config, entries } = await catalog(
        input.callerSessionId,
        input.kind,
      );
      const target = entries.find((item) => item.id === input.id);
      if (!target || (input.joined && !target.available))
        return {
          ok: false,
          errorCode: "CAPABILITY_NOT_AVAILABLE",
          message: "The capability is not available on this host.",
        };
      const selected = new Set(
        entries.filter((item) => item.joined).map((item) => item.id),
      );
      if (input.joined) selected.add(input.id);
      else selected.delete(input.id);
      const next =
        input.kind === "skill"
          ? { ...config, skills: [...selected] }
          : {
              ...config,
              mcpMode: "allowlist" as const,
              mcpServers: [...selected],
            };
      await options.current();
      await options.profiles.change(
        row.id,
        { capabilities: next },
        row.version,
      );
      await options.current();
      options.changed();
      return { ok: true, effective: "next-turn", joined: input.joined };
    },
  };
}
