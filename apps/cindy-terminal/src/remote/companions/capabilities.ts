import path from "node:path";
import type { AgentKind } from "@cindy/maker-core";
import type { XdtHelperMcpDeps } from "../../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js";
import type { TerminalCapabilities } from "../../tasks/capabilities.js";
import {
  companionCapabilities,
  type TerminalCompanionProfiles,
} from "./profiles.js";
import type { TerminalModelConfig } from "../../models/config.js";
import type { TerminalCompanionModels, CompanionModel } from "./models.js";

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
  models: TerminalModelConfig;
  modelSettings: TerminalCompanionModels;
  memoryEnabled(): boolean;
  change(
    patch: Parameters<TerminalCompanionProfiles["change"]>[1],
    expectedVersion: number,
  ): Promise<unknown>;
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
    models: async (input) => {
      await profile(input.callerSessionId);
      const optionsList = await options.modelSettings.choices();
      let current: CompanionModel | null = null;
      try {
        current = {
          ...(await options.models.select()).selection,
          fastMode: false,
        };
      } catch {
        await options.current();
      }
      const route = (choice: CompanionModel) => ({
        harness:
          choice.agentKind === "claude-code"
            ? ("claude" as const)
            : choice.agentKind,
        providerId: choice.providerId,
        model: choice.model,
        effort: choice.effort ?? "",
        fastMode: choice.fastMode,
        ...(choice.agentDeviceId
          ? { agentDeviceId: choice.agentDeviceId }
          : {}),
      });
      await options.current();
      return {
        ok: true,
        current: current ? route(current) : null,
        available: optionsList
          .filter((item) => item.available)
          .map((item) => ({
            id: item.id,
            route: route(item.choice),
            efforts: item.efforts,
            supportsFastMode: item.fast,
            supportsUltrafastMode: item.ultrafast,
          })),
      };
    },
    setDefaultModel: async (input) => {
      await profile(input.callerSessionId);
      const choice = (await options.modelSettings.choices()).find(
        (choice) => choice.id === input.id && choice.available,
      );
      if (!choice || choice.choice.agentDeviceId)
        return {
          ok: false,
          errorCode: "MODEL_DEFAULT_UNAVAILABLE",
          message:
            "Choose an available model on this computer for the application default.",
        };
      const selected = {
        ...choice.choice,
        ...(input.effort
          ? { effort: input.effort as CompanionModel["effort"] }
          : {}),
      };
      await options.modelSettings.validate(selected);
      await options.current();
      await options.models.setDefault(selected);
      await options.current();
      const saved = options.models.snapshot().defaultSelection;
      if (!saved) throw new Error("MODEL_DEFAULT_NOT_CONFIRMED");
      return {
        ok: true,
        effective: "new-tasks",
        current: {
          harness:
            saved.agentKind === "claude-code"
              ? ("claude" as const)
              : saved.agentKind,
          providerId: saved.providerId,
          model: saved.model,
          effort: saved.effort ?? "",
          fastMode: false,
        },
      };
    },
    inspect: async (input) => {
      const row = await profile(input.callerSessionId),
        config = companionCapabilities(row.capabilities);
      const candidates = row.models.length
        ? row.models
        : await options.modelSettings.defaults();
      const identitySource =
        (await options.profiles.read(row.id, "SOUL.md")) ?? "";
      await options.current();
      return {
        ok: true,
        state: {
          profile: {
            id: row.id,
            name: row.name,
            description: row.description,
            identitySource,
            version: row.version,
          },
          session: {
            id: row.sessionId,
            workingDir: path.join(options.profiles.home(row.id), "workspace"),
            remoteHostId: null,
          },
          model: {
            source: row.models.length ? "override" : "default",
            candidates: candidates.map((choice) => ({
              harness:
                choice.agentKind === "claude-code"
                  ? "claude"
                  : choice.agentKind,
              providerId: choice.providerId,
              model: choice.model,
              effort: choice.effort,
              fastMode: choice.fastMode,
              ...(choice.agentDeviceId
                ? { agentDeviceId: choice.agentDeviceId }
                : {}),
            })),
          },
          memory: { enabled: options.memoryEnabled(), scope: "self" },
          references: {
            skills: config.skills,
            mcpServers: config.mcpServers,
            toolsets: [],
          },
        },
      };
    },
    updateProfile: async (input) => {
      const row = await profile(input.callerSessionId);
      if (row.version !== input.expectedVersion)
        throw new Error("COMPANION_PROFILE_CHANGED");
      let models: CompanionModel[] | undefined;
      if (input.modelChain === null) models = [];
      else if (input.modelChain !== undefined) {
        if (!input.modelChain.length || input.modelChain.length > 5)
          throw new Error("INVALID_MODEL_CHAIN");
        const choices = await options.modelSettings.choices(row.models);
        models = input.modelChain.map((selection) => {
          const choice = choices.find(
            (choice) => choice.id === selection.id && choice.available,
          );
          if (!choice) throw new Error("MODEL_ROUTE_UNAVAILABLE");
          return {
            ...choice.choice,
            ...(selection.effort !== undefined
              ? { effort: selection.effort || undefined }
              : {}),
            ...(selection.fastMode !== undefined
              ? { fastMode: selection.fastMode }
              : {}),
          } as CompanionModel;
        });
      }
      await options.current();
      await options.change(
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.identitySource !== undefined
            ? { identitySource: input.identitySource }
            : {}),
          ...(models !== undefined ? { models } : {}),
        },
        input.expectedVersion,
      );
      await options.current();
      return { ok: true, effective: "next-turn" };
    },
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
