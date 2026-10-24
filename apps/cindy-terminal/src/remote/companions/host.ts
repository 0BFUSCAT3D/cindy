import type { TerminalWorktrees } from "../../worktrees/host.js";
import type { TerminalCapabilities } from "../../tasks/capabilities.js";
import type { TerminalKnowledge } from "../../knowledge.js";
import type { TerminalUtilityModels } from "../../models/utility.js";
import { createSessionPermissionChanges } from "@cindy/im-runtime/sessionPermissionChange";
import { changeSessionPermissionMode } from "@cindy/im-runtime/permissionModeControl";
import { permissionModeOrAsk } from "@cindy/maker-shared/permission-mode";
import { createAutoReviewIntentProjection } from "@cindy/maker-shared/auto-review-intent";
import { companionCapabilityCallbacks } from "./capabilities.js";
import type { WorktreeRuntimeLease } from "@cindy/worktree-core/runtimeLeases";
import type { TerminalCompanionRoutines } from "./routines.js";
import path from "node:path";
import {
  buildClientDeviceNote,
  buildMessageSourceNote,
  messageSourceSenderFromMeta,
} from "@cindy/maker-shared/message-source";
import {
  AUTO_REVIEW_SOURCE_CONTENT,
  AUTO_REVIEW_DELEGATED_CONTINUATION,
  AUTO_REVIEW_USER_INTENT,
} from "@cindy/maker-core";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  Maker,
  MakerMemoryManager,
  buildBotMemoryScopeKey,
  type AgentEvent,
  type BaseAgent,
  type InteractionRequest,
  type InteractionDecision,
  type Logger,
  type Session,
  type UserMessage,
  type PermissionModeDescriptor,
  type AutoReviewDelegate,
} from "@cindy/maker-core";
import { TerminalCompanionModels, type CompanionModel } from "./models.js";
import { createPluginSessionPermissions } from "../../plugins/session-permissions.js";
import type { PluginTaskContext } from "../../plugins/permissions.js";
import type { TerminalPluginTask } from "../../plugins/mcp.js";
import type { TerminalPluginSetup } from "../../plugins/setup.js";
import { installDesktopInteractionHandler } from "@cindy/im-runtime/interactionRouter";
import { buildBotSystemPrompt } from "@cindy/companion-core/prompt";
import { buildTeammateGuide } from "@cindy/companion-core/guide";
import {
  createBotTodoStore,
  type BotTodoStore,
} from "@cindy/companion-core/todoStore";
import { createBotWorkbenchStore } from "@cindy/companion-core/workbench";
import { createCindyMemoryMcpServer } from "../../../../../packages/lizi-mcps/src/cindy_memoryMcpServer.js";
import type { XdtHelperMcpDeps } from "../../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js";
import { createTaskTools } from "../../tasks/mcp.js";
import {
  normalizeTaskInput,
  appendInputText,
  inputPlainText,
  persistedInput,
  type InputHost,
  type AttachmentLifecycle,
} from "../../tasks/input.js";
import {
  TerminalTaskStorage,
  type HistoryRecord,
  type Submission,
} from "../../tasks/storage.js";
import {
  createTerminalAgent,
  type RuntimeInput,
} from "../../models/runtime.js";
import type {
  TerminalModelConfig,
  ModelSelection,
} from "../../models/config.js";
import type { InvocationContext } from "../../contracts.js";
import {
  TerminalCompanionProfiles,
  companionCapabilities,
  type TerminalCompanionProfile,
} from "./profiles.js";

type Live = {
  maker: Maker;
  session: Session;
  tools: Awaited<ReturnType<typeof createTaskTools>>;
  memory: MakerMemoryManager;
  revision: number;
  worktreeLease: WorktreeRuntimeLease | null;
  plugin?: TerminalPluginTask;
  revoke(): void;
  capability?: Awaited<ReturnType<TerminalCapabilities["runtime"]>>;
  knowledge?: Awaited<ReturnType<TerminalKnowledge["createRuntime"]>>;
  knowledgeRevision: string;
  modelRevision: number;
  modelDefaultsRevision: number;
  off: () => void;
};
type CompanionSchedule = NonNullable<Submission["scheduler"]>;
type CompanionContext = InvocationContext & {
  scheduler?: CompanionSchedule;
  targetPlugin?: Submission["targetPlugin"];
  normalizedInput?: boolean;
};
type Pending = {
  sessionId: string;
  sourceRequestId: string;
  request: InteractionRequest;
  resolve: (value: InteractionDecision) => void;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_ARGUMENT");
  return value as Record<string, unknown>;
};
const string = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("INVALID_ARGUMENT");
  return value;
};
const textOf = (event: AgentEvent) => {
  const data =
    typeof event.data === "string"
      ? { text: event.data }
      : object(event.data ?? {});
  return typeof data.text === "string"
    ? data.text
    : typeof data.content === "string"
      ? data.content
      : "";
};

/** Long-lived Profile identity with replaceable native handles. No TaskHost queue,
 * Orca orchestration, global skill shelf, or GUI singleton is inherited. */
export class TerminalCompanionHost {
  readonly profiles: TerminalCompanionProfiles;
  readonly modelSettings: TerminalCompanionModels;
  routines?: TerminalCompanionRoutines;
  readonly storage: TerminalTaskStorage;
  readonly workbench: ReturnType<typeof createBotWorkbenchStore>;
  private readonly todoStores = new Map<string, BotTodoStore>();
  private readonly live = new Map<string, Live>();
  private readonly starts = new Map<string, Promise<Live>>();
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<
    string,
    {
      clientId: string;
      text: string;
      finished: (value: string) => void;
      failed: (error: Error) => void;
    }
  >();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(botId: string) => void>();
  private closed = false;
  private readonly generations = new Map<string, number>();
  private readonly permissionChanges = createSessionPermissionChanges();
  private readonly deliveries = new Map<string, Promise<string>>();
  private pluginFactory?: (
    context: PluginTaskContext,
  ) => Promise<TerminalPluginTask>;
  private pluginSetup?: TerminalPluginSetup;
  private readonly pluginPermissions = createPluginSessionPermissions({
    session: (id) => (this.closed ? undefined : this.live.get(id)?.session),
    workingDir: async (id) => (await this.storage.get(id))?.workDir ?? null,
  });
  requestHostPermission = this.pluginPermissions.request;
  pluginPermissionSnapshot = (id: string, instance?: string) =>
    this.pluginPermissions.snapshot(id, instance);
  requestPluginWrite = (
    id: string,
    payload: import("@cindy/plugin-runtime/grantTypes").GhostGrantConfirmPayload,
    signal?: AbortSignal,
  ) => this.pluginPermissions.confirm(id, payload, signal);
  hasLiveSession(id: string) {
    return !this.closed && this.live.has(id);
  }
  configurePlugins(
    factory: (context: PluginTaskContext) => Promise<TerminalPluginTask>,
    setup: TerminalPluginSetup,
  ) {
    this.pluginFactory = factory;
    this.pluginSetup = setup;
  }
  private pluginTargetValidator?: (
    sessionId: string,
    clientId: string,
  ) => Promise<void>;
  private readonly steering = new Map<
    string,
    { controller: AbortController; result: Promise<"queue" | "steer"> }
  >();
  private readonly queueWake = new Map<string, Set<() => void>>();
  private async validateTarget(sessionId: string, clientId: string) {
    this.guard();
    if (!this.pluginTargetValidator)
      throw new Error("PLUGIN_TARGET_AUTHORITY_UNAVAILABLE");
    await this.pluginTargetValidator(sessionId, clientId);
    this.guard();
  }
  configurePluginTargetDelivery(
    validate: (sessionId: string, clientId: string) => Promise<void>,
  ) {
    this.pluginTargetValidator = validate;
    return {
      send: async (
        plugin: NonNullable<Submission["targetPlugin"]>,
        sessionId: string,
        clientId: string,
        text: string,
        images: import("@cindy/plugin-runtime/pluginMessageAttachments").PluginMessageImage[],
        guard: () => void,
        delivery: "queue" | "steer",
      ): Promise<"queue" | "steer"> => {
        guard();
        await this.validateTarget(sessionId, clientId);
        const profile = await this.profileForSession(sessionId);
        const input = {
          text,
          files: images.map((image) => ({
            type: "image",
            base64: image.buffer.toString("base64"),
            mimeType: image.mimeType,
            name: image.name,
          })),
        };
        const message = await this.prepareInput(sessionId, input);
        guard();
        await this.validateTarget(sessionId, clientId);
        const session = this.live.get(sessionId)?.session;
        if (
          delivery === "steer" &&
          session?.isTurnRunning() &&
          session.capabilities.sameTurnSteer.supported &&
          !this.steering.has(sessionId) &&
          !(await this.storage.get(sessionId))?.queuePaused &&
          ![...this.pending.values()].some(
            (item) => item.sessionId === sessionId,
          )
        ) {
          const controller = new AbortController();
          const result = this.steerTarget(
            profile,
            plugin,
            clientId,
            message,
            session,
            guard,
            controller.signal,
          );
          const operation = { controller, result };
          this.steering.set(sessionId, operation);
          try {
            return await result;
          } finally {
            if (this.steering.get(sessionId) === operation)
              this.steering.delete(sessionId);
          }
        }
        await this.send(profile.id, message, clientId, {
          source: "local",
          targetPlugin: plugin,
          assertCurrent: guard,
          normalizedInput: true,
        });
        return "queue";
      },
      withdraw: async (
        sessionId: string,
        clientId: string,
        guard: () => void,
      ) => {
        this.guard();
        guard();
        const receipt = await this.storage.submission(sessionId, clientId);
        guard();
        if (
          receipt?.targetPlugin &&
          receipt.status === "queued" &&
          this.active.get(sessionId)?.clientId !== clientId
        )
          await this.storage.updateSubmission(
            sessionId,
            clientId,
            "interrupted",
            "INPUT_CANCELLED",
          );
        this.wakeQueue(sessionId);
      },
      close: () => {
        if (this.pluginTargetValidator === validate)
          this.pluginTargetValidator = undefined;
      },
    };
  }
  private async steerTarget(
    profile: TerminalCompanionProfile,
    plugin: NonNullable<Submission["targetPlugin"]>,
    clientId: string,
    message: UserMessage,
    session: Session,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<"queue" | "steer"> {
    const id = profile.sessionId,
      generation = session.getTurnGeneration();
    const current = async () => {
      this.guard();
      guard();
      if (signal.aborted) throw new Error("COMPANION_STOPPED");
      await this.assertMayRun(profile.id);
      await this.validateTarget(id, clientId);
      guard();
    };
    const sameTurn = () =>
      this.live.get(id)?.session === session &&
      session.isTurnRunning() &&
      session.getTurnGeneration() === generation;
    let dispatched = false,
      accepted = false;
    const claim = await this.storage.claimSubmission(
      id,
      clientId,
      this.inputHash(message, plugin),
      () => {
        this.guard();
        guard();
      },
      { message, source: "local", targetPlugin: plugin },
    );
    if (!claim.created) throw new Error("DELIVERY_UNCERTAIN");
    try {
      await current();
      if (!sameTurn()) throw new Error("[STALE_TURN]");
      await this.storage.updateSubmission(id, clientId, "sending");
      const agentMeta = {
        sourcePlugin: { pluginId: plugin.id, name: plugin.name },
        delivery: "steer",
        autoReviewUserText: { kind: "delegated-continuation" },
      };
      const note = buildMessageSourceNote(
        messageSourceSenderFromMeta(agentMeta),
      );
      await session.steer(note ? appendInputText(message, note) : message, {
        signal,
        [AUTO_REVIEW_SOURCE_CONTENT]: "",
        [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
        beforeProviderStart: async () => {
          await current();
          if (!sameTurn()) throw new Error("[STALE_TURN]");
          dispatched = true;
        },
      });
      accepted = true;
      await this.storage.append(id, {
        kind: "user",
        message,
        clientId,
        origin: "local",
        agentMeta,
      });
      await this.storage.updateSubmission(id, clientId, "completed");
      this.changed(profile.id);
      return "steer";
    } catch (error) {
      if (accepted) {
        this.options.logger.warn("COMPANION_STEER_PERSISTENCE_FAILED");
        return "steer";
      }
      const reason = error instanceof Error ? error.message : "";
      if (
        dispatched &&
        !/\[NO_ACTIVE_TURN\]|\[STALE_TURN\]|no active .*turn|has no active turn/i.test(
          reason,
        )
      ) {
        await this.storage.update(id, { queuePaused: true });
        await this.storage.updateSubmission(
          id,
          clientId,
          "queued",
          "STEER_DELIVERY_UNCERTAIN",
        );
        throw new Error("DELIVERY_UNCERTAIN");
      }
      try {
        await current();
      } catch {
        await this.storage.updateSubmission(
          id,
          clientId,
          "failed",
          "DELIVERY_REJECTED",
        );
        throw new Error("DELIVERY_REJECTED");
      }
      const receipt = await this.storage.updateSubmission(
        id,
        clientId,
        "queued",
      );
      // Schedule after the steering lane releases; do not normalize or reserve a
      // second input when the original native turn ended before dispatch.
      this.queue(profile, receipt, {
        source: "local",
        targetPlugin: plugin,
        assertCurrent: guard,
      });
      return "queue";
    }
  }
  private inputHash(message: UserMessage, plugin?: Submission["targetPlugin"]) {
    return createHash("sha256")
      .update(
        JSON.stringify(plugin ? { message, targetPlugin: plugin } : message),
      )
      .digest("hex");
  }
  private wakeQueue(id: string) {
    for (const wake of this.queueWake.get(id) ?? []) wake();
    this.queueWake.delete(id);
  }
  async assertMayRun(id: string) {
    this.guard();
    await this.executionGuard?.(id);
    this.guard();
  }
  private executionGuard?: (id: string) => Promise<void>;
  setExecutionGuard(guard: (id: string) => Promise<void>) {
    this.executionGuard = guard;
  }
  readonly ready: Promise<void>;
  constructor(
    readonly options: {
      root: string;
      profileDir: string;
      models: TerminalModelConfig;
      resolveModel?: ConstructorParameters<
        typeof TerminalCompanionModels
      >[0]["resolve"];
      providerViews?: ConstructorParameters<
        typeof TerminalCompanionModels
      >[0]["views"];
      modelLocations?: ConstructorParameters<
        typeof TerminalCompanionModels
      >[0]["locations"];
      isGroupedProvider?: ConstructorParameters<
        typeof TerminalCompanionModels
      >[0]["isGrouped"];
      deviceStarter?(
        tools: Awaited<ReturnType<typeof createTaskTools>>,
        memory: MakerMemoryManager,
      ): NonNullable<
        ConstructorParameters<typeof Maker>[0]["startDeviceAgentSession"]
      >;
      logger: Logger;
      guard(): void;
      emit(channel: string, args: unknown[]): void;
      binary(kind: ModelSelection["agentKind"]): Promise<string | null>;
      helper?(input: {
        sessionId: string;
        workingDir: string;
        agentKind: ModelSelection["agentKind"];
        setTitle?: (title: string) => Promise<void>;
      }): XdtHelperMcpDeps;
      attachments?: Pick<InputHost, "ingestAttachment" | "resolveAttachment">;
      createAgent?: (input: RuntimeInput) => Promise<BaseAgent>;
      protectedInput?: import("../../protected-input.js").TerminalProtectedInput;
      worktrees?: TerminalWorktrees;
      capabilities?: TerminalCapabilities;
      knowledge?: Pick<TerminalKnowledge, "createRuntime" | "snapshot">;
      utility?: Pick<TerminalUtilityModels, "reviewPermission">;
      permissionModes?(
        kind: ModelSelection["agentKind"],
      ): readonly PermissionModeDescriptor[];
    },
  ) {
    this.modelSettings = new TerminalCompanionModels({
      root: options.root,
      models: options.models,
      binary: options.binary,
      locations: options.modelLocations,
      guard: () => this.guard(),
      resolve: options.resolveModel,
      views: options.providerViews,
      isGrouped: options.isGroupedProvider,
    });
    this.profiles = new TerminalCompanionProfiles(options.root, () =>
      this.guard(),
    );
    this.workbench = createBotWorkbenchStore({
      profileDir: (_root, id) => this.profiles.home(id),
      directoryKey: (directory) =>
        process.platform === "win32"
          ? path.win32.normalize(directory).toLowerCase()
          : path.normalize(directory),
      logger: options.logger,
      changed: (id) => this.changed(id),
    });
    this.storage = new TerminalTaskStorage(path.join(options.root, "history"));
    this.ready = Promise.all([
      this.storage.open(),
      this.modelSettings.ready,
    ]).then(() => {});
  }
  hasRunningWork() {
    return this.active.size > 0 || this.starts.size > 0 || this.queues.size > 0;
  }
  private guard() {
    if (this.closed) throw new Error("COMPANION_HOST_CLOSED");
    this.options.guard();
  }
  private emit(channel: string, payload: unknown) {
    if (!this.closed) this.options.emit(channel, [payload]);
  }
  onChange(listener: (id: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(id: string) {
    for (const listener of this.listeners) listener(id);
    this.emit("maker:remote-resources:changed", { collectionId: "teammates" });
  }
  async owns(sessionId: string) {
    return (await this.profiles.list()).some(
      (profile) => profile.sessionId === sessionId,
    );
  }
  async todos(id: string) {
    this.guard();
    const profile = await this.profiles.get(id);
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    let store = this.todoStores.get(id);
    if (!store) {
      store = createBotTodoStore(
        path.join(this.profiles.home(id), "todos.v1.json"),
        () =>
          this.workbench.readLegacyWorkbenchJudgments(this.options.root, id),
        () => this.guard(),
        () => {
          const active = this.active.get(profile.sessionId);
          return !active?.clientId.startsWith("schedule_");
        },
      );
      this.todoStores.set(id, store);
    }
    return store;
  }
  async profileForSession(sessionId: string) {
    const profile = (await this.profiles.list()).find(
      (profile) => profile.sessionId === sessionId,
    );
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    return profile;
  }
  async ensureCanonical(profile: TerminalCompanionProfile) {
    await this.ready;
    this.guard();
    if (!(await this.storage.get(profile.sessionId))) {
      let selection: CompanionModel | undefined;
      let error: unknown;
      const chain = profile.models.length
        ? profile.models
        : await this.modelSettings.defaults();
      for (const choice of chain) {
        try {
          await this.modelSettings.validate(choice);
          selection = choice;
          break;
        } catch (value) {
          error = value;
        }
      }
      if (!selection) throw error ?? new Error("COMPANION_MODEL_UNAVAILABLE");
      this.guard();
      await this.storage.create({
        id: profile.sessionId,
        agentKind: selection.agentKind,
        model: selection.model,
        workDir: path.join(this.profiles.home(profile.id), "workspace"),
        title: profile.name,
        permissionMode: "default",
        providerId: selection.providerId,
        effort: selection.effort,
        fastMode: selection.fastMode,
        agentDeviceId: selection.agentDeviceId,
        source: "bot",
      });
      await this.storage.setSelection(profile.sessionId, selection);
    }
    return profile.sessionId;
  }
  async create(input: Parameters<TerminalCompanionProfiles["create"]>[0]) {
    const profile = await this.profiles.create(input);
    this.changed(profile.id);
    return profile;
  }
  async change(
    id: string,
    patch: Parameters<TerminalCompanionProfiles["change"]>[1],
    expectedVersion?: number,
    guard: () => void = () => {},
  ) {
    if (patch.models)
      for (const choice of this.modelSettings.parseChain(patch.models))
        await this.modelSettings.validate(choice);
    guard();
    const profile = await this.profiles.change(
      id,
      patch,
      expectedVersion,
      guard,
    );
    if (patch.status) {
      await this.routines?.lifecycle(
        id,
        patch.status === "paused" ? "pause" : "resume",
      );
      if (patch.status === "paused") await this.stop(id);
    }
    this.changed(id);
    return profile;
  }
  async remove(id: string) {
    await this.routines?.lifecycle(id, "delete");
    await this.stop(id);
    await this.profiles.remove(id);
    this.changed(id);
  }
  async isBusy(id: string) {
    const profile = await this.profiles.get(id);
    return (
      !!profile &&
      (this.active.has(profile.sessionId) || this.queues.has(profile.sessionId))
    );
  }
  private async skillEntries(
    profile: TerminalCompanionProfile,
    includeDisabled = false,
  ) {
    const result: Array<{
      name: string;
      description: string;
      slug: string;
      path: string;
      filePath: string;
    }> = [];
    for (const slug of await this.profiles.files(profile.id, "skills")) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(slug)) continue;
      if (
        !includeDisabled &&
        !(await this.profiles.skillEnabled(profile.id, slug))
      )
        continue;
      const body = await this.profiles.readSkill(profile.id, slug);
      if (!body) continue;
      const scalar = (value: string) => {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      const name = scalar(/^name:\s*(.*)$/m.exec(body)?.[1] ?? slug);
      const description = scalar(
        /^description:\s*(.*)$/m.exec(body)?.[1] ?? "",
      );
      result.push({
        name,
        description,
        slug,
        path: path.join(this.profiles.home(profile.id), "skills", slug),
        filePath: path.join(
          this.profiles.home(profile.id),
          "skills",
          slug,
          "SKILL.md",
        ),
      });
    }
    return result;
  }
  private helper(
    profile: TerminalCompanionProfile,
    selection: ModelSelection,
  ): XdtHelperMcpDeps {
    const caller = (id: string) => {
      this.guard();
      if (id !== profile.sessionId) throw new Error("COMPANION_SCOPE_MISMATCH");
    };
    return {
      ...this.options.helper?.({
        sessionId: profile.sessionId,
        workingDir: path.join(this.profiles.home(profile.id), "workspace"),
        agentKind: selection.agentKind,
        setTitle: async (title) => {
          await this.change(profile.id, { name: title });
        },
      }),
      resolveSurface: async () => "bot-main",
      runtimeCapabilities: async () => ({
        terminal: true,
        companion: true,
        memory: this.options.knowledge?.snapshot().memory ?? true,
        skills: true,
        mcp: Boolean(this.options.capabilities),
        contacts: this.options.knowledge?.snapshot().contacts ?? false,
        plugins: Boolean(this.pluginFactory),
      }),
      ...(this.options.capabilities
        ? {
            botCapabilities: companionCapabilityCallbacks({
              botId: profile.id,
              sessionId: profile.sessionId,
              agentKind: selection.agentKind,
              profiles: this.profiles,
              capabilities: this.options.capabilities,
              models: this.options.models,
              modelSettings: this.modelSettings,
              memoryEnabled: () =>
                this.options.knowledge?.snapshot().memory ?? true,
              change: (patch, version) =>
                this.change(profile.id, patch, version),
              current: () => this.assertMayRun(profile.id),
              changed: () => this.changed(profile.id),
            }),
          }
        : {}),
      ...(this.routines
        ? {
            botRoutines: {
              resolveBotId: async (id: string) => {
                caller(id);
                return profile.id;
              },
              service: this.routines.service,
            },
          }
        : {}),
      botSkills: {
        list: async (input) => {
          caller(input.callerSessionId);
          const all = (await this.skillEntries(profile, true)).filter(
            (skill) =>
              !input.query ||
              input.query
                .toLowerCase()
                .split(/\s+/)
                .every((word) =>
                  (skill.name + " " + skill.description)
                    .toLowerCase()
                    .includes(word),
                ),
          );
          const offset = input.offset ?? 0,
            limit = Math.min(input.limit ?? 50, 200);
          return {
            ok: true,
            skills: all.slice(offset, offset + limit).map((skill) => ({
              ...skill,
              updatedAt: new Date(profile.updatedAt).toISOString(),
              enabled: true,
            })),
            total: all.length,
            ...(offset + limit < all.length
              ? { nextOffset: offset + limit }
              : {}),
          };
        },
        save: async (input) => {
          caller(input.callerSessionId);
          const slug =
            input.slug ??
            input.name
              .toLowerCase()
              .replace(/[^a-z0-9_-]+/g, "-")
              .replace(/^-+|-+$/g, "");
          if (!slug) throw new Error("SKILL_SLUG_REQUIRED");
          const created = !(await this.profiles.readSkill(profile.id, slug));
          await this.profiles.writeSkill(
            profile.id,
            slug,
            `---\nname: ${JSON.stringify(input.name)}\ndescription: ${JSON.stringify(input.description)}\n---\n\n${input.body}`,
          );
          await this.profiles.change(profile.id, {});
          this.changed(profile.id);
          return {
            ok: true,
            created,
            effective: "next-session",
            skill: {
              slug,
              name: input.name,
              description: input.description,
              updatedAt: new Date().toISOString(),
              filePath: path.join(
                this.profiles.home(profile.id),
                "skills",
                slug,
                "SKILL.md",
              ),
              enabled: true,
            },
          };
        },
      },
    };
  }
  private ensureLive(profile: TerminalCompanionProfile): Promise<Live> {
    const current = this.live.get(profile.sessionId);
    if (
      current?.session.getStatus() === "active" &&
      (current.session.isTurnRunning() ||
        (current.revision === profile.version &&
          current.capability?.revision ===
            this.options.capabilities?.revision() &&
          current.modelRevision === this.options.models.revision() &&
          current.modelDefaultsRevision === this.modelSettings.revision() &&
          current.knowledgeRevision ===
            JSON.stringify(this.options.knowledge?.snapshot())))
    )
      return Promise.resolve(current);
    const existing = this.starts.get(profile.sessionId);
    if (existing) return existing;
    const start = this.start(profile);
    this.starts.set(profile.sessionId, start);
    void start
      .finally(() => this.starts.delete(profile.sessionId))
      .catch(() => {});
    return start;
  }
  private start(profile: TerminalCompanionProfile): Promise<Live> {
    // A new runtime must read the permission committed by the latest settings
    // change; it cannot race the live-mode update and start with an older row.
    return this.permissionChanges.withSessionPermissionChange(
      profile.sessionId,
      () => this.startRuntime(profile),
    );
  }
  private async startRuntime(profile: TerminalCompanionProfile): Promise<Live> {
    await this.closeSession(profile.sessionId);
    this.guard();
    await this.executionGuard?.(profile.id);
    if (profile.status !== "active") throw new Error("COMPANION_PAUSED");
    await this.ensureCanonical(profile);
    let failure: unknown;
    const defaultsRevision = this.modelSettings.revision();
    const chain = profile.models.length
      ? profile.models
      : await this.modelSettings.defaults();
    for (const choice of chain) {
      let tools: Live["tools"] | undefined,
        memory: MakerMemoryManager | undefined,
        maker: Maker | undefined,
        agent: BaseAgent | undefined,
        capability: Live["capability"],
        knowledge: Live["knowledge"],
        plugin: TerminalPluginTask | undefined,
        lease: Live | undefined,
        worktreeLease: WorktreeRuntimeLease | null = null;
      let revoked = false;
      const reviewAbort = new AbortController();
      const assertCurrent = () => {
        this.guard();
        if (revoked || (lease && this.live.get(profile.sessionId) !== lease))
          throw new Error("COMPANION_RUNTIME_REPLACED");
      };
      const instanceId = () => {
        assertCurrent();
        if (!lease) throw new Error("COMPANION_NOT_READY");
        return lease.session.instanceId;
      };
      const modelRevision = this.options.models.revision();
      const knowledgeRevision = JSON.stringify(
        this.options.knowledge?.snapshot(),
      );
      try {
        const resolved = await this.modelSettings.resolve(
          choice,
          profile.sessionId,
          path.join(this.profiles.home(profile.id), "workspace"),
        );
        const { selection, route, agentDeviceId } = resolved;
        const binary = await this.options.binary(selection.agentKind);
        if (!binary && !agentDeviceId) throw new Error("ENGINE_NOT_INSTALLED");
        this.guard();
        const scope = buildBotMemoryScopeKey(profile.id),
          home = this.profiles.home(profile.id),
          workingDir = path.join(home, "workspace");
        const references = companionCapabilities(profile.capabilities);
        capability = await this.options.capabilities?.runtime({
          workingDir,
          agentKind: selection.agentKind,
          ...(references.mcpMode === "allowlist"
            ? { mcpIds: references.mcpServers }
            : {}),
        });
        memory = new MakerMemoryManager({
          basePath: path.join(this.options.root, "memory"),
          resolveStorageDir: (key) =>
            key === scope ? path.join(home, "memories") : null,
          isIndependentScope: (key) => key === scope,
          resolveBasePath: () => {
            this.guard();
            return path.join(this.options.root, "memory");
          },
          ownerScopeKey: () => {
            this.guard();
            return this.options.root;
          },
          sqliteFactory: (file) => new Database(file),
          agents: {},
          initialEnabled: this.options.knowledge?.snapshot().memory ?? true,
          reloadEnabled: () =>
            this.options.knowledge?.snapshot().memory ?? true,
          logger: this.options.logger,
        });
        const currentMemory = memory;
        knowledge = await this.options.knowledge?.createRuntime(
          {
            sessionId: profile.sessionId,
            workingDir,
            agentKind: selection.agentKind,
          },
          {
            memory,
            scopeKey: scope,
            assertCurrent: () => this.assertMayRun(profile.id),
          },
        );
        plugin = await this.pluginFactory?.({
          sessionId: profile.sessionId,
          workingDir,
          instanceId,
          assertCurrent,
          snapshot: () =>
            this.pluginPermissionSnapshot(profile.sessionId, instanceId()),
          confirm: (payload, signal) =>
            this.requestPluginWrite(profile.sessionId, payload, signal),
        });
        tools = await createTaskTools({
          logger: this.options.logger,
          sessionId: profile.sessionId,
          workingDir,
          agentKind: selection.agentKind,
          isCurrent: () => {
            try {
              assertCurrent();
              return true;
            } catch {
              return false;
            }
          },
          helper: this.helper(profile, selection),
          extraFactories: {
            ...capability?.factories,
            ...plugin?.factories,
            ...(knowledge?.factories ?? {
              cindy_memory: () =>
                createCindyMemoryMcpServer({
                  getManager: () => currentMemory,
                  workdir: workingDir,
                  getSessionContext: () => ({
                    sessionId: profile.sessionId,
                    workingDir,
                    agentKind: selection.agentKind,
                    memoryScopeKey: scope,
                  }),
                  withAccountDataAccess: async (_session, operation) => {
                    this.guard();
                    const result = await operation(async () => this.guard());
                    this.guard();
                    return result;
                  },
                }),
            }),
          },
        });
        let reviewAutoPermissionAction: AutoReviewDelegate | undefined;
        if (this.options.utility) {
          reviewAutoPermissionAction = (request) =>
            this.options.utility!.reviewPermission(
              request,
              assertCurrent,
              reviewAbort.signal,
            );
          reviewAutoPermissionAction.prepareRequest = async (request) => {
            assertCurrent();
            await this.assertMayRun(profile.id);
            if (request.sessionId && request.sessionId !== profile.sessionId)
              throw new Error("COMPANION_SCOPE_MISMATCH");
            // This is the stable owner chat. Delegation authority belongs to a
            // separate owned-task receipt, never to arbitrary native input.
            const {
              delegatedTask: _delegation,
              authorizationError: _error,
              ...ordinary
            } = request;
            assertCurrent();
            return ordinary;
          };
        }
        agent = await (this.options.createAgent ?? createTerminalAgent)({
          reviewAutoPermissionAction,
          profileDir: this.options.profileDir,
          taskId: profile.sessionId,
          selection,
          route,
          binaryPath: binary ?? process.execPath,
          remote: Boolean(agentDeviceId),
          models: this.options.models,
          logger: this.options.logger,
          tools,
          memory,
          capabilities: capability,
          getGhostRosterPrompt: plugin?.getGhostRosterPrompt,
          contactsEnabled: knowledge?.contactsEnabled,
          getContactsPromptState: () =>
            this.options.knowledge?.snapshot().contacts
              ? "enabled"
              : "disabled",
          taskShellEnv: () =>
            this.options.protectedInput?.envFor(profile.sessionId) ?? {},
        });
        const skills = await this.skillEntries(profile);
        const snapshot = memory.isEnabled()
          ? await (await memory.getStore(scope)).getIndex()
          : "";
        const sharedSkills =
          references.skills.length && this.options.capabilities
            ? (
                await this.options.capabilities.listSkills(
                  [workingDir],
                  selection.agentKind,
                )
              ).items
            : [];
        const guide = buildTeammateGuide({
          helperAvailable: false,
          cindyAvailable: Boolean(plugin),
          ownSkillsEnabled: true,
          pluginAuthorizationCardsEnabled: Boolean(plugin),
        });
        const row = await this.storage.get(profile.sessionId);
        const resumeSessionId =
          row?.sdkSessionId &&
          row.agentKind === selection.agentKind &&
          row.providerId === selection.providerId &&
          row.agentDeviceId === agentDeviceId
            ? row.sdkSessionId
            : undefined;
        const prompt = buildBotSystemPrompt({
          displayName: profile.name,
          identity: (await this.profiles.read(profile.id, "SOUL.md")) ?? "",
          userProfile: (await this.profiles.read(profile.id, "USER.md")) ?? "",
          homeDir: home,
          skillIndex: skills,
          contextSections: [
            guide,
            ...(!resumeSessionId
              ? [
                  (await this.messages(profile.sessionId))
                    .slice(-30)
                    .map((message) => message.role + ": " + message.content)
                    .join("\n")
                    .slice(-24000),
                ]
              : []),
          ],
          memorySnapshot: snapshot,
          capabilities: {
            toolsets: ["memory"],
            memoryEnabled: memory.isEnabled(),
            partnerActionsEnabled: false,
            ownSkillsEnabled: true,
            botModeEnabled: true,
          },
        });
        maker = new Maker({
          agents: { [selection.agentKind]: agent },
          storage: this.storage,
          logger: this.options.logger,
          makerMemory: memory,
          ...(agentDeviceId
            ? {
                startDeviceAgentSession: this.options.deviceStarter?.(
                  tools,
                  memory,
                ),
              }
            : {}),
        });
        if (agentDeviceId && !this.options.deviceStarter)
          throw new Error("REMOTE_AGENT_UNAVAILABLE");
        worktreeLease =
          (await this.options.worktrees?.runtime.acquireWorktreeRuntimeLease(
            profile.sessionId,
            workingDir,
          )) ?? null;
        this.guard();
        await this.executionGuard?.(profile.id);
        const session = await maker.createSession({
          id: profile.sessionId,
          agentKind: selection.agentKind,
          workingDir,
          title: profile.name,
          model: selection.model,
          providerId: selection.providerId,
          effort: selection.effort,
          permissionMode:
            row?.permissionMode === "default"
              ? "ask"
              : permissionModeOrAsk(row?.permissionMode),
          fastMode: choice.fastMode,
          ...(agentDeviceId ? { agentDeviceId } : {}),
          botProfilePrompt: prompt.stable,
          botProfileContextPrompt: [prompt.context, prompt.volatile]
            .filter(Boolean)
            .join("\n\n"),
          botRuntimeProfile: {
            botId: profile.id,
            profileVersion: profile.version,
            skillPolicy: {
              mode: "allowlist",
              configured: references.skills,
              catalog: sharedSkills.map((skill) => ({
                name: skill.name,
                path: skill.mdPath ?? skill.absolutePath,
                enabled: skill.enabled,
                scope: skill.scope,
              })),
              ownSkills: skills,
            },
            mcpPolicy: {
              mode: "allowlist",
              configured: tools.providers.map((value) => value.name),
              catalog: tools.providers.map((value) => ({
                name: value.name,
                source: Object.hasOwn(capability?.factories ?? {}, value.name)
                  ? ("custom" as const)
                  : ("builtin" as const),
                available: true,
              })),
            },
            toolsetPolicy: { mode: "allowlist", configured: [], catalog: [] },
          },
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        const live: Live = {
          maker,
          session,
          tools,
          memory,
          worktreeLease,
          capability,
          knowledge,
          modelRevision,
          modelDefaultsRevision: defaultsRevision,
          knowledgeRevision,
          plugin,
          revoke: () => {
            revoked = true;
            reviewAbort.abort();
          },
          revision: profile.version,
          off: () => {},
        };
        live.off = session.onEvent((event) => this.event(profile, event));
        installDesktopInteractionHandler(
          session,
          (request) => this.interaction(profile.sessionId, request),
          (sourceRequestId, decision) => {
            for (const pending of this.pending.values())
              if (
                pending.sessionId === profile.sessionId &&
                pending.sourceRequestId === sourceRequestId
              )
                pending.resolve(decision);
          },
        );
        this.guard();
        lease = live;
        await this.storage.setSelection(profile.sessionId, selection);
        await this.storage.update(profile.sessionId, {
          agentDeviceId: agentDeviceId ?? undefined,
          groupBinding: resolved.groupBinding,
          fastMode: choice.fastMode,
        });
        this.guard();
        this.live.set(profile.sessionId, live);
        return live;
      } catch (error) {
        failure = error;
        revoked = true;
        reviewAbort.abort();
        lease?.off();
        plugin?.close();
        if (maker) await maker.shutdown();
        else await agent?.dispose();
        if (worktreeLease)
          await this.options.worktrees!.runtime.releaseWorktreeRuntimeLease(
            worktreeLease,
          );
        await tools?.close();
        await capability?.close();
        await knowledge?.close();
        await memory?.dispose();
      }
    }
    throw failure ?? new Error("COMPANION_MODEL_UNAVAILABLE");
  }
  private event(profile: TerminalCompanionProfile, event: AgentEvent) {
    const id = profile.sessionId,
      captured = this.active.get(id);
    void this.storage
      .append(id, { kind: "event", event })
      .then(async (row) => {
        this.emit("maker:event", {
          sessionId: id,
          event,
          sequence: row.sequence,
        });
        this.changed(profile.id);
        const active = captured;
        if (
          !active ||
          this.active.get(id) !== active ||
          event.turnScope === "background"
        )
          return;
        if (event.type === "text") {
          const data =
            typeof event.data === "object"
              ? (event.data as { isFinal?: boolean })
              : {};
          active.text = data?.isFinal
            ? textOf(event)
            : active.text + textOf(event);
        }
        if (
          event.type === "done" ||
          (event.type === "error" &&
            (event.data as { isTerminal?: boolean })?.isTerminal !== false)
        ) {
          this.active.delete(id);
          await this.storage.updateSubmission(
            id,
            active.clientId,
            event.type === "done" ? "completed" : "failed",
            event.type === "error" ? "COMPANION_TURN_FAILED" : undefined,
            active.text,
          );
          if (event.type === "done") active.finished(active.text);
          else active.failed(new Error("COMPANION_TURN_FAILED"));
        }
      })
      .catch((error) => {
        this.active.get(id)?.failed(error);
        this.active.delete(id);
        void this.live.get(id)?.session.abort();
      });
  }
  private interaction(
    sessionId: string,
    request: InteractionRequest,
    signal?: AbortSignal,
  ): Promise<InteractionDecision> {
    if (
      !["permission", "ask_user_question", "plan_review"].includes(request.kind)
    )
      return Promise.reject(new Error("COMPANION_INTERACTION_UNAVAILABLE"));
    const requestId = randomUUID();
    const publicRequest = { ...request, requestId };
    return new Promise((resolve) => {
      let settled = false;
      const done = (decision: InteractionDecision) => {
        if (settled) return;
        settled = true;
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", abort);
        resolve(decision);
        this.emit("maker:interaction-dismissed", { sessionId, requestId });
      };
      const abort = () =>
        done(
          request.kind === "ask_user_question"
            ? { kind: "ask_user_question", answers: {} }
            : ({
                kind: request.kind,
                behavior: "deny",
                reason: "Request cancelled",
              } as InteractionDecision),
        );
      this.pending.set(requestId, {
        sessionId,
        sourceRequestId: request.requestId,
        request: publicRequest,
        resolve: done,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.emit("maker:interaction-request", {
        sessionId,
        request: publicRequest,
      });
      if (signal?.aborted || this.closed) abort();
    });
  }
  async prepareInput(sessionId: string, input: unknown) {
    const profile = await this.profileForSession(sessionId);
    return normalizeTaskInput(
      { profileDir: this.options.root, ...this.options.attachments },
      sessionId,
      input,
      { source: "local" },
      path.join(this.profiles.home(profile.id), "workspace"),
      () => this.guard(),
    );
  }
  async send(
    id: string,
    input: unknown,
    clientId: string = randomUUID(),
    context?: CompanionContext,
  ): Promise<{
    accepted: true;
    clientId: string;
    completion: Promise<string>;
  }> {
    this.guard();
    context?.assertCurrent?.();
    await this.executionGuard?.(id);
    if (
      !(
        context?.targetPlugin
          ? /^plugin-target:[A-Za-z0-9_-]{1,100}$/
          : /^[A-Za-z0-9_-]{1,100}$/
      ).test(clientId)
    )
      throw new Error("INVALID_CLIENT_ID");
    const profile = await this.profiles.get(id);
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    if (profile.status !== "active") throw new Error("COMPANION_PAUSED");
    await this.ensureCanonical(profile);
    const lifecycle: AttachmentLifecycle = { accepted: [], cleanup: [] };
    try {
      const message = context?.normalizedInput
        ? (input as UserMessage)
        : await normalizeTaskInput(
            { profileDir: this.options.root, ...this.options.attachments },
            profile.sessionId,
            input,
            context ?? { source: "local" },
            path.join(this.profiles.home(id), "workspace"),
            () => {
              this.guard();
              context?.assertCurrent?.();
            },
            lifecycle,
          );
      if (inputPlainText(message).length > 200_000)
        throw new Error("INVALID_COMPANION_MESSAGE");
      if (context?.targetPlugin)
        await this.validateTarget(profile.sessionId, clientId);
      const hash = this.inputHash(message, context?.targetPlugin);
      const claim = await this.storage.claimSubmission(
        profile.sessionId,
        clientId,
        hash,
        () => {
          this.guard();
          context?.assertCurrent?.();
        },
        {
          message,
          source: context?.source ?? "local",
          deviceId: context?.deviceId,
          sourceDevice: context?.sourceDevice,
          targetPlugin: context?.targetPlugin,
          ...(context?.scheduler ? { scheduler: context.scheduler } : {}),
        },
      );
      if (!claim.created) {
        if (claim.receipt.status === "completed")
          return {
            accepted: true,
            clientId,
            completion: Promise.resolve(claim.receipt.finalText ?? ""),
          };
        const running = this.deliveries.get(profile.sessionId + ":" + clientId);
        if (running) return { accepted: true, clientId, completion: running };
        if (claim.receipt.status !== "queued")
          throw new Error(
            "COMPANION_DELIVERY_" + claim.receipt.status.toUpperCase(),
          );
      }
      for (const accept of lifecycle.accepted) await accept();
      return {
        accepted: true,
        clientId,
        completion: this.queue(profile, claim.receipt, context),
      };
    } finally {
      await Promise.allSettled(lifecycle.cleanup.map((cleanup) => cleanup()));
    }
  }
  async submitScheduled(
    id: string,
    text: string,
    origin: CompanionSchedule,
    assertCurrent: () => void,
  ) {
    return this.send(id, text, `schedule_${origin.runId}`, {
      source: "local",
      scheduler: origin,
      assertCurrent,
    });
  }
  private queue(
    profile: TerminalCompanionProfile,
    receipt: Submission,
    context?: CompanionContext,
  ): Promise<string> {
    const key = profile.sessionId + ":" + receipt.requestId;
    const current = this.deliveries.get(key);
    if (current) return current;
    const generation = this.generations.get(profile.id) ?? 0;
    let resolve!: (value: string) => void, reject!: (reason: Error) => void;
    const completion = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completion.catch(() => {});
    this.deliveries.set(key, completion);
    const assertCurrent = () => {
      this.guard();
      context?.assertCurrent?.();
      if ((this.generations.get(profile.id) ?? 0) !== generation)
        throw new Error("COMPANION_STOPPED");
    };
    const previous = this.queues.get(profile.sessionId) ?? Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(async () => {
        await this.steering.get(profile.sessionId)?.result.catch(() => {});
        while ((await this.storage.get(profile.sessionId))?.queuePaused) {
          assertCurrent();
          if (
            (
              await this.storage.submission(
                profile.sessionId,
                receipt.requestId,
              )
            )?.status !== "queued"
          )
            throw new Error("INPUT_CANCELLED");
          await new Promise<void>((resolve) => {
            const waiters = this.queueWake.get(profile.sessionId) ?? new Set();
            waiters.add(resolve);
            this.queueWake.set(profile.sessionId, waiters);
            void this.storage.get(profile.sessionId).then(
              (row) => {
                if (
                  !row?.queuePaused ||
                  this.closed ||
                  (this.generations.get(profile.id) ?? 0) !== generation
                )
                  this.wakeQueue(profile.sessionId);
              },
              () => this.wakeQueue(profile.sessionId),
            );
          });
        }
        if (
          (await this.storage.submission(profile.sessionId, receipt.requestId))
            ?.status !== "queued"
        )
          throw new Error("INPUT_CANCELLED");
        if (receipt.targetPlugin)
          await this.validateTarget(profile.sessionId, receipt.requestId);
        assertCurrent();
        await this.executionGuard?.(profile.id);
        const fresh = await this.profiles.get(profile.id);
        if (!fresh || fresh.status !== "active")
          throw new Error("COMPANION_PAUSED");
        if (!receipt.message) throw new Error("COMPANION_MESSAGE_MISSING");
        const live = await this.ensureLive(fresh);
        assertCurrent();
        await this.executionGuard?.(profile.id);
        const sourceDevice =
          receipt.source === "remote" ? (receipt.sourceDevice ?? null) : null;
        const sourceMeta = receipt.targetPlugin
          ? {
              sourcePlugin: {
                pluginId: receipt.targetPlugin.id,
                name: receipt.targetPlugin.name,
              },
              autoReviewUserText: { kind: "delegated-continuation" },
            }
          : receipt.scheduler
            ? { origin: receipt.scheduler }
            : sourceDevice
              ? { sourceDevice }
              : undefined;
        const projection = createAutoReviewIntentProjection();
        const authoredText =
          projection.readText(persistedInput(receipt.message)) ?? "";
        const delegated = Boolean(receipt.targetPlugin || receipt.scheduler);
        const agentMeta = {
          ...sourceMeta,
          delivery: "turn",
          autoReviewUserText: receipt.scheduler
            ? { kind: "scheduled-continuation" }
            : receipt.targetPlugin
              ? { kind: "delegated-continuation" }
              : authoredText,
        };
        await this.storage.append(profile.sessionId, {
          kind: "user",
          message: receipt.message,
          clientId: receipt.requestId,
          origin: receipt.source ?? "local",
          ...(agentMeta ? { agentMeta } : {}),
        });
        assertCurrent();
        this.active.set(profile.sessionId, {
          clientId: receipt.requestId,
          text: "",
          finished: resolve,
          failed: reject,
        });
        await this.storage.updateSubmission(
          profile.sessionId,
          receipt.requestId,
          "sending",
        );
        assertCurrent();
        const pluginNote = receipt.targetPlugin
          ? buildMessageSourceNote(messageSourceSenderFromMeta(agentMeta))
          : null;
        const message = pluginNote
          ? appendInputText(receipt.message, pluginNote)
          : receipt.scheduler
            ? appendInputText(
                receipt.message,
                `[Scheduled run context]\nschedule: ${JSON.stringify(receipt.scheduler.scheduleName)} (schedule_id: ${receipt.scheduler.scheduleId})\nrun_id: ${receipt.scheduler.runId}\nfiredAtUtc: ${new Date(receipt.scheduler.firedAt ?? Date.now()).toISOString()}`,
              )
            : sourceDevice
              ? appendInputText(
                  receipt.message,
                  buildClientDeviceNote(sourceDevice),
                )
              : receipt.message;
        const history = (await this.messages(profile.sessionId)).map((row) => ({
          ...row,
          createdAt: Date.parse(row.createdAt),
        }));
        const intent = projection.restore(
          history,
          delegated
            ? undefined
            : {
                clientId: receipt.requestId,
                content: persistedInput(receipt.message),
                authoredText,
              },
        );
        const result = await live.session.send(message, {
          [AUTO_REVIEW_USER_INTENT]: intent,
          [AUTO_REVIEW_SOURCE_CONTENT]: receipt.message.content,
          ...(receipt.scheduler ? { origin: receipt.scheduler } : {}),
          ...(delegated
            ? {
                [AUTO_REVIEW_SOURCE_CONTENT]: "",
                [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
              }
            : {}),
          beforeProviderStart: async () => {
            assertCurrent();
            await this.executionGuard?.(profile.id);
            if (receipt.targetPlugin)
              await this.validateTarget(profile.sessionId, receipt.requestId);
            assertCurrent();
          },
        });
        if (!result.accepted) throw new Error(result.reason);
        if (
          (await this.storage.submission(profile.sessionId, receipt.requestId))
            ?.status === "sending"
        )
          await this.storage.updateSubmission(
            profile.sessionId,
            receipt.requestId,
            "running",
          );
        await completion;
      })
      .catch(async (error) => {
        const active = this.active.get(profile.sessionId);
        if (active?.clientId === receipt.requestId)
          this.active.delete(profile.sessionId);
        const latest = await this.storage.submission(
          profile.sessionId,
          receipt.requestId,
        );
        if (
          latest &&
          !["completed", "interrupted", "failed"].includes(latest.status)
        )
          await this.storage.updateSubmission(
            profile.sessionId,
            receipt.requestId,
            "failed",
            error instanceof Error ? error.message : "COMPANION_TURN_FAILED",
          );
        reject(error);
      });
    this.queues.set(profile.sessionId, queued);
    void queued.finally(() => {
      if (this.queues.get(profile.sessionId) === queued)
        this.queues.delete(profile.sessionId);
      this.deliveries.delete(key);
    });
    this.changed(profile.id);
    return completion;
  }
  /** Only definitely unsubmitted work is resumed, after the caller installed its
   * owner/home lease fence. Ambiguous native turns remain interrupted. */
  async resumePending(id?: string) {
    await this.ready;
    for (const profile of await this.profiles.list()) {
      if ((id && profile.id !== id) || profile.status !== "active") continue;
      await this.executionGuard?.(profile.id);
      for (const receipt of await this.storage.queued(profile.sessionId))
        this.queue(profile, receipt);
    }
  }
  private async closeSession(sessionId: string) {
    this.options.protectedInput?.handoff.cleanupForSession(sessionId);
    this.pluginSetup?.bridge.cleanupForSession(sessionId, "session_closed");
    const current = this.live.get(sessionId);
    if (!current) return;
    current.revoke();
    current.plugin?.close();
    this.live.delete(sessionId);
    for (const pending of [...this.pending.values()])
      if (pending.sessionId === sessionId)
        pending.resolve(
          pending.request.kind === "ask_user_question"
            ? { kind: "ask_user_question", answers: {} }
            : ({
                kind: pending.request.kind,
                behavior: "deny",
                reason: "Session closed",
              } as InteractionDecision),
        );
    this.active.get(sessionId)?.failed(new Error("COMPANION_STOPPED"));
    this.active.delete(sessionId);
    current.off();
    await current.maker.shutdown();
    if (current.worktreeLease)
      await this.options.worktrees!.runtime.releaseWorktreeRuntimeLease(
        current.worktreeLease,
      );
    await current.tools.close();
    await current.capability?.close();
    await current.knowledge?.close();
    await current.memory.dispose();
  }
  async stop(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const profile = await this.profiles.get(id);
    if (profile) {
      this.steering.get(profile.sessionId)?.controller.abort();
      this.wakeQueue(profile.sessionId);
      await this.closeSession(profile.sessionId);
    }
  }
  async records(id: string, after = 0, limit = 200): Promise<HistoryRecord[]> {
    await this.ready;
    const profile = await this.profiles.get(id);
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    await this.ensureCanonical(profile);
    return (await this.storage.history(profile.sessionId, after, limit))
      .records;
  }
  async messages(sessionId: string) {
    const profile = await this.profileForSession(sessionId);
    await this.ensureCanonical(profile);
    const result: Array<{
      id: string;
      clientId: string;
      sessionId: string;
      role: string;
      content: string;
      createdAt: string;
      agentKind: string;
      agentMeta: Record<string, unknown> | null;
    }> = [];
    let cursor = 0;
    let assistant: (typeof result)[number] | undefined;
    const row = await this.storage.get(sessionId);
    do {
      const page = await this.storage.history(sessionId, cursor, 1000);
      for (const entry of page.records) {
        const base = {
          id: `${sessionId}:${entry.sequence}`,
          clientId: entry.clientId ?? `${sessionId}:${entry.sequence}`,
          sessionId,
          createdAt: new Date(
            typeof entry.agentMeta?.cloudCreatedAt === "number"
              ? entry.agentMeta.cloudCreatedAt
              : entry.timestamp,
          ).toISOString(),
          agentKind:
            row?.agentKind === "claude-code" ? "cc" : (row?.agentKind ?? "pi"),
          agentMeta: entry.agentMeta ?? null,
        };
        if (entry.kind === "user" && entry.message) {
          assistant = undefined;
          result.push({
            ...base,
            role: "user",
            content: persistedInput(entry.message),
          });
        } else if (entry.event?.type === "text") {
          const text = textOf(entry.event);
          if (!assistant || entry.event.standaloneText) {
            assistant = { ...base, role: "assistant", content: text };
            result.push(assistant);
          } else
            assistant.content = (entry.event.data as { isFinal?: boolean })
              ?.isFinal
              ? text
              : assistant.content + text;
          if (entry.event.standaloneText) assistant = undefined;
        } else if (entry.event?.type === "done") assistant = undefined;
      }
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    } while (true);
    return result;
  }
  async projection(sessionId: string, options: Record<string, unknown> = {}) {
    const requested = options.deliveryClientIds;
    const receipts = Array.isArray(requested)
      ? await Promise.all(
          requested.slice(0, 100).map(async (clientId) => {
            const receipt =
              typeof clientId === "string"
                ? await this.storage.submission(sessionId, clientId)
                : null;
            return {
              clientId,
              state: receipt ? "accepted" : "unknown",
              turnStatus: receipt?.status,
              finalText: receipt?.finalText,
              errorCode: receipt?.error,
            };
          }),
        )
      : undefined;
    return {
      sessionId,
      terminalTurnReceiptsVersion: 1,
      deliveryReceipts: receipts,
      turnInProgress: this.active.has(sessionId),
      pendingQueue: (await this.storage.queued(sessionId)).map((receipt) => ({
        id: receipt.requestId,
        clientId: receipt.requestId,
        text: inputPlainText(receipt.message),
        createdAt: receipt.createdAt,
        source: receipt.source ?? "local",
        ...(receipt.targetPlugin
          ? {
              sourcePlugin: {
                pluginId: receipt.targetPlugin.id,
                name: receipt.targetPlugin.name,
              },
            }
          : {}),
      })),
      steeringQueueClientIds: [],
      queuePaused: (await this.storage.get(sessionId))?.queuePaused === true,
      queueExpanded: true,
      queueInteractionLocks: [],
      queueEditLocks: [],
      queueAbortPending: false,
      error: null,
      errorReason: null,
      recovery: null,
      errorRetryText: null,
      credentialSwitchWait: null,
    };
  }
  async permissionState(id: string) {
    const profile = await this.profiles.get(id);
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    await this.ensureCanonical(profile);
    const row = await this.storage.get(profile.sessionId);
    if (!row) throw new Error("COMPANION_NOT_FOUND");
    const modes =
      this.options.permissionModes?.(row.agentKind) ??
      this.live.get(profile.sessionId)?.session.capabilities.permissionModes;
    return {
      mode:
        row.permissionMode === "default"
          ? "ask"
          : permissionModeOrAsk(row.permissionMode),
      modes: (modes ?? []).filter(
        (mode) => mode.id !== "auto" || Boolean(this.options.utility),
      ),
    };
  }
  async changePermission(
    id: string,
    value: unknown,
    confirmedFullAccess: boolean,
    context: InvocationContext,
  ) {
    this.guard();
    context.assertCurrent?.();
    if (context.sharedTask) throw new Error("COMPANION_OWNER_REQUIRED");
    const profile = await this.profiles.get(id);
    if (!profile) throw new Error("COMPANION_NOT_FOUND");
    await this.executionGuard?.(id);
    const state = await this.permissionState(id),
      mode = state.modes.find((mode) => mode.id === value);
    if (!mode) throw new Error("INVALID_PERMISSION_MODE");
    const current = () => {
      this.guard();
      context.assertCurrent?.();
    };
    const result = await changeSessionPermissionMode(
      {
        sessionId: profile.sessionId,
        mode: mode.id,
        modes: state.modes,
        confirmedFullAccess,
        readPreviousMode: async () => {
          await this.executionGuard?.(id);
          return (await this.permissionState(id)).mode;
        },
        getLiveSession: () => this.live.get(profile.sessionId)?.session ?? null,
        persist: async (mode) => {
          current();
          await this.storage.update(profile.sessionId, {
            permissionMode: mode,
          });
          current();
        },
      },
      {
        ...this.permissionChanges,
        captureAccount: () => ({
          assertCurrent: current,
          isCurrent: () => {
            try {
              current();
              return true;
            } catch {
              return false;
            }
          },
        }),
      },
    );
    if (result.kind !== "changed")
      throw new Error(
        result.kind === "confirmation-required"
          ? "PERMISSION_CONFIRMATION_REQUIRED"
          : result.reason,
      );
    this.emit("local-db:sessions:patched", {
      sessionId: profile.sessionId,
      patch: { permissionMode: mode.id },
    });
    this.changed(id);
    return { success: true };
  }
  async invoke(
    channel: string,
    args: unknown[],
    context: InvocationContext,
  ): Promise<unknown> {
    this.guard();
    context.assertCurrent?.();
    if (context.sharedTask) throw new Error("COMPANION_OWNER_REQUIRED");
    const id =
      channel === "local-db:history:messages"
        ? string(object(args[0]).sessionId)
        : string(args[0]);
    const profile = await this.profileForSession(id);
    switch (channel) {
      case "maker:set-permission-mode":
        // The existing GUI command already owns its Full access confirmation.
        return this.changePermission(profile.id, args[1], true, context);
      case "maker:input:resume":
        await this.storage.update(id, { queuePaused: false });
        this.wakeQueue(id);
        await this.resumePending(profile.id);
        return this.projection(id);
      case "maker:input:remove": {
        const clientId = string(args[1]);
        const receipt = await this.storage.submission(id, clientId);
        if (
          !receipt ||
          receipt.status !== "queued" ||
          this.active.get(id)?.clientId === clientId
        )
          throw new Error("QUEUED_MESSAGE_NOT_FOUND");
        await this.storage.updateSubmission(
          id,
          clientId,
          "interrupted",
          "INPUT_CANCELLED",
        );
        this.wakeQueue(id);
        return this.projection(id);
      }
      case "maker:send":
      case "maker:input:enqueue": {
        const input =
          typeof args[1] === "string" ? { text: args[1] } : object(args[1]);
        const sent = await this.send(
          profile.id,
          input.message ?? input,
          typeof input.clientId === "string" ? input.clientId : undefined,
          context,
        );
        return { accepted: true, clientId: sent.clientId, sessionId: id };
      }
      case "maker:input:get-projection":
        return this.projection(id, args[1] ? object(args[1]) : {});
      case "local-db:history:messages":
      case "local-db:messages:list": {
        const opts =
          channel === "local-db:history:messages"
            ? object(args[0])
            : args[1]
              ? object(args[1])
              : {};
        const rows = await this.messages(id);
        return rows
          .filter(
            (row) =>
              (!opts.before ||
                Number(row.id.split(":").at(-1)) <
                  Number(String(opts.before).split(":").at(-1))) &&
              (!opts.after ||
                Number(row.id.split(":").at(-1)) >
                  Number(String(opts.after).split(":").at(-1))),
          )
          .slice(
            -Math.min(1000, typeof opts.limit === "number" ? opts.limit : 200),
          );
      }
      case "maker:abort-session":
        await this.stop(profile.id);
        return { ok: true };
      case "maker:session-in-turn":
        return this.isBusy(profile.id);
      case "maker:get-context-usage":
        return this.live.get(id)?.session.getUsageSnapshot() ?? null;
      case "maker:get-pending-interactions":
        return [
          ...(this.options.protectedInput?.handoff.pendingSnapshots(id) ?? []),
          ...(this.pluginSetup?.bridge.pendingSnapshots(id) ?? []),
          ...[...this.pending.values()]
            .filter((row) => row.sessionId === id)
            .map((row) => ({ request: row.request })),
        ];
      case "local-db:sessions:get":
        return {
          id,
          title: profile.name,
          agentKind: (await this.storage.get(id))?.agentKind ?? "pi",
          permissionMode: (await this.permissionState(profile.id)).mode,
          botId: profile.id,
          status: "active",
          createdAt: new Date(profile.createdAt).toISOString(),
          updatedAt: new Date(profile.updatedAt).toISOString(),
        };
      case "terminal:tasks:history":
        return this.storage.history(
          id,
          typeof args[1] === "number" ? args[1] : 0,
        );
      default:
        throw new Error("COMPANION_CHANNEL_UNAVAILABLE");
    }
  }
  resolveInteraction(
    requestId: string,
    decision: unknown,
    context: InvocationContext,
  ) {
    this.guard();
    context.assertCurrent?.();
    if (context.sharedTask) throw new Error("COMPANION_OWNER_REQUIRED");
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("INTERACTION_NOT_FOUND");
    const value = object(decision);
    if (value.kind !== pending.request.kind)
      throw new Error("INVALID_INTERACTION_DECISION");
    let clean: InteractionDecision;
    if (value.kind === "ask_user_question") {
      const answers = object(value.answers);
      if (Object.values(answers).some((value) => typeof value !== "string"))
        throw new Error("INVALID_ANSWERS");
      clean = {
        kind: "ask_user_question",
        answers: answers as Record<string, string>,
      };
    } else {
      if (value.behavior !== "allow" && value.behavior !== "deny")
        throw new Error("INVALID_PERMISSION_DECISION");
      clean =
        value.kind === "permission"
          ? {
              kind: "permission",
              behavior: value.behavior,
              ...(typeof value.reason === "string"
                ? { reason: value.reason }
                : {}),
            }
          : {
              kind: "plan_review",
              behavior: value.behavior,
              ...(typeof value.editedPlan === "string"
                ? { editedPlan: value.editedPlan }
                : {}),
            };
    }
    pending.resolve(clean);
    return { success: true };
  }
  hasInteraction(id: string) {
    return this.pending.has(id);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.steering.values()) entry.controller.abort();
    for (const id of this.queueWake.keys()) this.wakeQueue(id);
    await Promise.allSettled(this.starts.values());
    await Promise.allSettled(
      [...this.live.keys()].map((id) => this.closeSession(id)),
    );
    await Promise.allSettled(
      [...this.steering.values()].map((entry) => entry.result),
    );
    await Promise.allSettled(this.queues.values());
    await this.storage.flush();
    await this.profiles.close();
  }
}
