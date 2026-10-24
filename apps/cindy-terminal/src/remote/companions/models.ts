import path from "node:path";
import { createHash } from "node:crypto";
import { resolveNewMakerDefaultTuple } from "@cindy/model-providers/model-plane/newMakerDefaultTuple";
import { normalizeModelRoute } from "@cindy/maker-shared/model-route";
import {
  modelSupportsFastMode,
  resolveRoute,
  type ProviderView,
  type ResolvedRoute,
} from "@cindy/model-providers";
import {
  ENGINES,
  parseSelection,
  type ModelSelection,
  type TerminalModelConfig,
} from "../../models/config.js";
import { atomicPrivateWrite, readPrivateFile } from "../../platform.js";

export type CompanionModel = ModelSelection & {
  fastMode: boolean | "ultrafast";
  agentDeviceId?: string;
};
export function parseCompanionModel(value: unknown): CompanionModel {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_MODEL_SELECTION");
  const input = value as Record<string, unknown>;
  const agentKind =
    input.agentKind ??
    (input.harness === "claude" ? "claude-code" : input.harness);
  const normalized = normalizeModelRoute({
    ...input,
    harness: agentKind === "claude-code" ? "claude" : agentKind,
  });
  if (!normalized || !normalized.providerId)
    throw new Error("INVALID_MODEL_SELECTION");
  if (
    input.fastMode !== undefined &&
    typeof input.fastMode !== "boolean" &&
    input.fastMode !== "ultrafast"
  )
    throw new Error("INVALID_FAST_MODE");
  return {
    ...parseSelection({
      ...input,
      agentKind,
      providerId: normalized.providerId,
      effort: normalized.effort || undefined,
    }),
    fastMode: normalized.fastMode,
    ...(normalized.agentDeviceId
      ? { agentDeviceId: normalized.agentDeviceId }
      : {}),
  };
}
export type CompanionModelResolution = Awaited<
  ReturnType<TerminalModelConfig["select"]>
> & {
  agentDeviceId?: string;
  groupBinding?: import("@cindy/remote-agent/groups/bindings").ProviderGroupBinding;
};
export const companionModelKey = (route: CompanionModel) =>
  JSON.stringify([
    route.agentDeviceId ?? "",
    route.agentKind,
    route.providerId,
    route.model,
  ]);
export type CompanionModelOption = {
  id: string;
  label: string;
  choice: CompanionModel;
  efforts: string[];
  fast: boolean;
  ultrafast: boolean;
  available: boolean;
};

/** An independent companion default, never the last selection in a task. */
export class TerminalCompanionModels {
  private readonly file: string;
  private override: CompanionModel[] | null = null;
  private pending: Promise<void>;
  readonly ready: Promise<void>;
  private generation = 0;
  constructor(
    private readonly options: {
      root: string;
      models: TerminalModelConfig;
      guard(): void;
      binary(kind: ModelSelection["agentKind"]): Promise<string | null>;
      views?(device?: string): Promise<ProviderView[]>;
      locations?(): Promise<Array<{ agentDeviceId: string; name: string }>>;
      isGrouped?(providerId: string): boolean;
      resolve?(
        choice: CompanionModel,
        sessionId: string,
        workingDir: string,
      ): Promise<CompanionModelResolution>;
    },
  ) {
    this.file = path.join(options.root, "model-defaults.json");
    const file = this.file;
    this.ready = (async () => {
      const data = await readPrivateFile(file);
      if (!data) return;
      const value = JSON.parse(data.toString());
      if (value.version !== 1 || !Array.isArray(value.models))
        throw new Error("INVALID_COMPANION_MODEL_DEFAULTS");
      this.override = this.parseChain(value.models);
    })();
    this.pending = Promise.resolve();
  }
  revision() {
    return this.generation;
  }
  parseChain(value: unknown): CompanionModel[] {
    if (!Array.isArray(value) || value.length > 5)
      throw new Error("INVALID_MODEL_CHAIN");
    const result = value.map(parseCompanionModel);
    const seen = new Set<string>();
    for (const route of result) {
      const key = companionModelKey(route);
      if (seen.has(key)) throw new Error("DUPLICATE_MODEL_ROUTE");
      seen.add(key);
    }
    return result;
  }
  async defaults() {
    await this.ready;
    await this.pending;
    this.options.guard();
    if (this.override?.length) return structuredClone(this.override);
    const providers = await this.options.models.views();
    const binaries = await Promise.all(
      ENGINES.map(async (kind) =>
        (await this.options.binary(kind))
          ? kind === "claude-code"
            ? ("cc" as const)
            : kind
          : null,
      ),
    );
    const primary = resolveNewMakerDefaultTuple({
      providers,
      providersLoading: false,
      availableAgents: new Set(
        binaries.filter((kind): kind is "cc" | "codex" | "pi" => kind !== null),
      ),
      availableAgentsLoaded: true,
      isModelEnabled: (agent, providerId, model) =>
        providers
          .find((item) => item.id === providerId)
          ?.models[agent]?.some(
            (item) =>
              item.id === model.id &&
              !item.disabled &&
              item.defaultEnabled !== false,
          ) === true,
    });
    this.options.guard();
    return primary
      ? [
          {
            agentKind:
              primary.vendor === "cc"
                ? ("claude-code" as const)
                : primary.vendor,
            providerId: primary.providerId,
            model: primary.model,
            fastMode: false as const,
            ...(primary.effort ? { effort: primary.effort } : {}),
          },
        ]
      : [];
  }
  async resolve(
    choice: CompanionModel,
    sessionId: string,
    workingDir: string,
  ): Promise<CompanionModelResolution> {
    this.options.guard();
    if (choice.agentDeviceId && !this.options.resolve)
      throw new Error("REMOTE_AGENT_UNAVAILABLE");
    const resolved = this.options.resolve
      ? await this.options.resolve(choice, sessionId, workingDir)
      : await this.options.models.select(choice);
    this.options.guard();
    this.validateTuning(choice, resolved.route);
    return resolved;
  }
  private validateTuning(choice: CompanionModel, route: ResolvedRoute) {
    if (choice.effort && !route.model.efforts.includes(choice.effort))
      throw new Error("INVALID_MODEL_EFFORT");
    if (
      choice.fastMode &&
      !modelSupportsFastMode(route.provider, choice.model, choice.agentKind)
    )
      throw new Error("FAST_MODE_UNAVAILABLE");
    if (choice.fastMode === "ultrafast" && !route.model.supportsUltrafastMode)
      throw new Error("ULTRAFAST_MODE_UNAVAILABLE");
  }
  async validate(choice: CompanionModel) {
    this.options.guard();
    if (choice.agentDeviceId && !this.options.views)
      throw new Error("REMOTE_AGENT_UNAVAILABLE");
    const views = await (this.options.views?.(choice.agentDeviceId) ??
      this.options.models.views());
    const route = resolveRoute(
      views,
      choice.providerId,
      choice.model,
      choice.agentKind,
    );
    if (
      !route ||
      !route.provider.connected ||
      route.provider.suspended ||
      route.model.disabled
    )
      throw new Error("MODEL_ROUTE_UNAVAILABLE");
    if (
      !choice.agentDeviceId &&
      !this.options.isGrouped?.(choice.providerId) &&
      !(await this.options.binary(choice.agentKind))
    )
      throw new Error("ENGINE_NOT_INSTALLED");
    this.options.guard();
    this.validateTuning(choice, route);
    return route;
  }
  async state() {
    await this.ready;
    await this.pending;
    this.options.guard();
    const configured = structuredClone(this.override ?? []);
    return {
      configured,
      revision: createHash("sha256")
        .update(JSON.stringify(configured))
        .digest("hex"),
      effective: configured.length ? configured : await this.defaults(),
    };
  }
  /** Catalog reads never reserve a provider-group member or start an agent. */
  async choices(selected: CompanionModel[] = []) {
    await this.ready;
    this.options.guard();
    const locations = (await this.options.locations?.()) ?? [];
    const sources = new Map<string | undefined, string>([[undefined, ""]]);
    for (const location of locations)
      sources.set(location.agentDeviceId, location.name);
    for (const choice of selected)
      if (choice.agentDeviceId && !sources.has(choice.agentDeviceId))
        sources.set(choice.agentDeviceId, choice.agentDeviceId);
    const installed = new Set(
      (
        await Promise.all(
          ENGINES.map(async (kind) =>
            (await this.options.binary(kind)) ? kind : null,
          ),
        )
      ).filter(Boolean),
    );
    const result = new Map<string, CompanionModelOption>();
    const queue = [...sources.entries()];
    const read = async () => {
      for (;;) {
        const source = queue.shift();
        if (!source) return;
        const [device, name] = source;
        let providers: ProviderView[];
        try {
          providers = await (this.options.views?.(device) ??
            (device
              ? Promise.reject(new Error("REMOTE_AGENT_UNAVAILABLE"))
              : this.options.models.views()));
        } catch {
          this.options.guard();
          continue;
        }
        this.options.guard();
        for (const provider of providers)
          for (const kind of ENGINES)
            for (const model of provider.models[kind] ?? []) {
              if (
                !provider.connected ||
                provider.suspended ||
                model.disabled ||
                (!device &&
                  !this.options.isGrouped?.(provider.id) &&
                  !installed.has(kind))
              )
                continue;
              // A native Claude subscription is never transferred to another harness.
              if (
                provider.id === "anthropic" &&
                provider.source !== "user" &&
                kind !== "claude-code"
              )
                continue;
              const choice: CompanionModel = {
                agentKind: kind,
                providerId: provider.id,
                model: model.id,
                fastMode: false,
                ...(device ? { agentDeviceId: device } : {}),
              };
              const id = companionModelKey(choice);
              result.set(id, {
                id,
                label: [name, provider.name, kind, model.name]
                  .filter(Boolean)
                  .join(" · "),
                choice,
                efforts: model.efforts,
                fast: modelSupportsFastMode(provider, model.id, kind),
                ultrafast: Boolean(model.supportsUltrafastMode),
                available: true,
              });
            }
      }
    };
    await Promise.all([read(), read()]);
    this.options.guard();
    for (const choice of selected) {
      const id = companionModelKey(choice);
      if (!result.has(id))
        result.set(id, {
          id,
          label: [
            choice.agentDeviceId,
            choice.providerId,
            choice.agentKind,
            choice.model,
          ]
            .filter(Boolean)
            .join(" · "),
          choice,
          efforts: [],
          fast: false,
          ultrafast: false,
          available: false,
        });
    }
    return [...result.values()];
  }
  async saveDefaults(
    value: unknown,
    guard: () => void = () => {},
    expectedRevision?: string,
  ) {
    const chain = this.parseChain(value);
    const write = this.pending.then(async () => {
      await this.ready;
      this.options.guard();
      guard();
      if (
        expectedRevision !== undefined &&
        expectedRevision !==
          createHash("sha256")
            .update(JSON.stringify(this.override ?? []))
            .digest("hex")
      )
        throw new Error("COMPANION_MODEL_DEFAULTS_CHANGED");
      for (const choice of chain) await this.validate(choice);
      this.options.guard();
      guard();
      await atomicPrivateWrite(
        this.file,
        JSON.stringify({ version: 1, models: chain }),
      );
      this.override = chain.length ? chain : null;
      this.generation++;
    });
    this.pending = write.catch(() => {});
    return write;
  }
}
