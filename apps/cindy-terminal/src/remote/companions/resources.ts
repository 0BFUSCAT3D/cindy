import type {
  RemoteResourceRegistry,
  RemoteCollectionItem,
  RemoteActionDescriptor,
} from "@cindy/device-link";
import type { TerminalCompanionCloud } from "./cloud.js";
import type { TerminalCompanionHost } from "./host.js";
import { remoteText as text } from "../text.js";
import { parseCompanionModel } from "./models.js";
import {
  registerCompanionModelResources,
  companionModelsTitle,
  companionModelsRef,
} from "./model-resources.js";
const string = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("INVALID_ARGUMENT");
  return value;
};
export function registerCompanionResources(
  registry: RemoteResourceRegistry,
  host: TerminalCompanionHost,
  cloud?: TerminalCompanionCloud,
) {
  registerCompanionModelResources(registry, host);
  const actions: RemoteActionDescriptor[] = [
    { id: "model-settings", label: companionModelsTitle },
    {
      id: "create",
      label: text("Add teammate"),
      fields: [
        { id: "name", label: text("Name"), kind: "text", required: true },
        { id: "description", label: text("Description"), kind: "multiline" },
      ],
    },
  ];
  const item = async (id: string): Promise<RemoteCollectionItem> => {
    const profile = await host.profiles.get(id);
    const actor = cloud?.homes
      .snapshot()
      .actors.find((actor) => actor.externalId === id);
    if (
      !profile ||
      (actor?.homeDeviceId &&
        actor.homeDeviceId !== cloud?.homes.snapshot().selfDeviceId)
    ) {
      if (!actor) throw new Error("COMPANION_NOT_FOUND");
      return {
        ref: { collectionId: "teammates", kind: "bot", id },
        revision: actor.homeDeviceId ?? "",
        display: { title: actor.name, subtitle: text("Primary computer") },
        links: [],
        actions: [
          { id: "open", label: text("Open conversation") },
          { id: "move-here", label: text("Move here") },
        ],
      };
    }
    return {
      ref: { collectionId: "teammates", kind: "bot", id },
      revision: String(profile.version),
      display: {
        title: profile.name,
        subtitle: profile.description,
        status: {
          label: text(profile.status === "paused" ? "Paused" : "Ready"),
          tone: profile.status === "paused" ? "neutral" : "positive",
        },
      },
      links: [
        {
          rel: "conversation",
          label: text("Open conversation"),
          target: { kind: "session", sessionId: profile.sessionId },
        },
      ],
      actions: [
        { id: "open", label: text("Open conversation") },
        { id: "model-settings", label: text("Models") },
        {
          id: "edit",
          label: text("Edit profile"),
          fields: [
            { id: "name", label: text("Name"), kind: "text", required: true },
            {
              id: "description",
              label: text("Description"),
              kind: "multiline",
            },
            { id: "soul", label: text("Identity"), kind: "multiline" },
          ],
        },
        {
          id: profile.status === "paused" ? "resume" : "pause",
          label: text(profile.status === "paused" ? "Resume" : "Pause"),
        },
        { id: "delete", label: text("Delete teammate"), tone: "destructive" },
      ],
    };
  };
  registry.register({
    collection: {
      id: "teammates",
      resourceKind: "bot",
      title: text("Teammates"),
      placement: "home-scope",
      actions,
    },
    list: async (_context, request) => {
      const query = request.query?.toLowerCase();
      const local = await host.profiles.list();
      const remote = (cloud?.homes.snapshot().actors ?? [])
        .filter(
          (actor) => !local.some((profile) => profile.id === actor.externalId),
        )
        .map((actor) => ({
          id: actor.externalId,
          name: actor.name,
          description: "",
          version: 0,
        }));
      const rows = [...local, ...remote].filter(
        (profile) =>
          !query ||
          (profile.name + " " + profile.description)
            .toLowerCase()
            .includes(query),
      );
      return {
        collectionId: "teammates",
        revision: rows.map((row) => row.id + ":" + row.version).join("|"),
        items: await Promise.all(
          rows.slice(0, request.limit ?? 200).map((row) => item(row.id)),
        ),
      };
    },
    get: async (_context, request) => {
      const result = await item(request.ref.id);
      const profile = await host.profiles.get(request.ref.id);
      let description = profile?.description ?? "";
      if (!profile && cloud) {
        const page = (await cloud.invoke("maker:companion-cloud:transcript", [
          request.ref.id,
        ])) as { messages?: Array<{ role: string; text: string }> };
        description = (page.messages ?? [])
          .map((message) => message.role + ": " + message.text)
          .join("\n\n");
      }
      return {
        ...result,
        blocks: [
          { id: "profile", primitive: "text", fallbackMarkdown: description },
        ],
      };
    },
    invoke: async (context, request) => {
      context.assertCurrent?.();
      const input = request.input ?? {};
      const id = request.resourceRef?.id;
      if (request.actionId === "model-settings")
        return {
          effects: [
            {
              kind: "navigate",
              target: { kind: "resource", ref: companionModelsRef(id) },
            },
          ],
        };
      if (request.actionId === "create") {
        const profile = await host.create({
          name: string(input.name),
          description:
            typeof input.description === "string" ? input.description : "",
        });
        context.assertCurrent?.();
        return {
          result: { botId: profile.id },
          effects: [{ kind: "refresh-collection", collectionId: "teammates" }],
        };
      }
      if (!id) throw new Error("COMPANION_NOT_FOUND");
      if (request.actionId === "move-here") {
        if (!cloud) throw new Error("COMPANION_CLOUD_NOT_ENABLED");
        const result = await cloud.invoke("maker:companion-cloud:take-over", [
          id,
        ]);
        return {
          result,
          effects: [{ kind: "refresh-collection", collectionId: "teammates" }],
        };
      }
      if (request.actionId === "open") {
        const actor = cloud?.homes
          .snapshot()
          .actors.find((actor) => actor.externalId === id);
        if (
          actor?.homeDeviceId &&
          actor.homeDeviceId !== cloud?.homes.snapshot().selfDeviceId
        ) {
          const value = (await cloud!.options.remoteInvoke(
            actor.homeDeviceId,
            "maker:remote-resources:get",
            [
              {
                client: request.client,
                ref: { collectionId: "teammates", kind: "bot", id },
              },
            ],
          )) as {
            links?: Array<{ target?: { kind?: string; sessionId?: string } }>;
          };
          const sessionId = value.links?.find(
            (link) => link.target?.kind === "session",
          )?.target?.sessionId;
          if (!sessionId)
            throw new Error("REMOTE_COMPANION_SESSION_UNAVAILABLE");
          return {
            result: { deviceId: actor.homeDeviceId, sessionId },
            effects: [],
          };
        }
        const profile = await host.profiles.get(id);
        if (!profile) throw new Error("COMPANION_NOT_FOUND");
        await host.ensureCanonical(profile);
        return {
          result: { sessionId: profile.sessionId },
          effects: [
            {
              kind: "navigate",
              target: { kind: "session", sessionId: profile.sessionId },
            },
          ],
        };
      }
      if (request.actionId === "edit") {
        await host.change(id, {
          name: string(input.name),
          description:
            typeof input.description === "string" ? input.description : "",
        });
        if (typeof input.soul === "string")
          await host.profiles.write(id, "SOUL.md", input.soul);
      } else if (request.actionId === "pause" || request.actionId === "resume")
        await host.change(id, {
          status: request.actionId === "pause" ? "paused" : "active",
        });
      else if (request.actionId === "delete") {
        if (cloud) await cloud.retire(id);
        await host.remove(id);
      } else if (request.actionId === "model") {
        await host.change(id, { models: [parseCompanionModel(input)] });
      } else if (request.actionId === "model-default")
        await host.change(id, { models: [] });
      else throw new Error("INVALID_ACTION");
      context.assertCurrent?.();
      return {
        effects: [
          { kind: "refresh-collection", collectionId: "teammates" },
          { kind: "refresh-resource", ref: request.resourceRef! },
        ],
      };
    },
  });
}
