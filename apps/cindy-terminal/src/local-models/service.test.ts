import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { zstdCompressSync } from "node:zlib";
import path from "node:path";
import os from "node:os";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import {
  RemoteResourceRegistry,
  type RemoteResource,
} from "@cindy/device-link";
import { MANAGED_OLLAMA_PROVIDER_ID } from "@cindy/model-providers/localModelRuntime";
import { streamOllamaPull } from "@cindy/model-providers/local-runtime/ollamaClient";
import { TerminalModelConfig } from "../models/config.js";
import type { TerminalClient, TerminalSecrets } from "../contracts.js";
import { runResourceCommand } from "../resource-commands.js";
import { TerminalLocalModels, type LocalModelJob } from "./service.js";
import { extractLinuxOllama } from "./archive.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
// Integration tier: remote host downloads must survive controller detach and
// daemon restart without publishing into a retired owner. Exercise the real
// resource registry, model persistence and streaming HTTP (no runtime mocks).
it("manages remote downloads, resumes durable progress and fences the owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-local-models-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const installed = new Set<string>();
  const downloads = new Map<string, ServerResponse>();
  let downloadStarted = deferred();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/version")
      res.end(JSON.stringify({ version: "0.40.10" }));
    else if (req.url === "/api/tags")
      res.end(
        JSON.stringify({
          models: [...installed].map((name) => ({ name, size: 1024 })),
        }),
      );
    else if (req.url === "/api/show")
      res.end(
        JSON.stringify({
          capabilities: ["completion", "tools"],
          model_info: {
            "general.architecture": "fixture",
            "fixture.context_length": 65536,
          },
        }),
      );
    else if (req.url === "/api/delete") {
      installed.delete(body.name);
      res.end("{}");
    } else if (req.url === "/api/pull") {
      downloads.set(body.name, res);
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(
        JSON.stringify({
          status: "pulling layer",
          digest: "sha256:" + "a".repeat(64),
          total: 100,
          completed: 50,
        }) + "\n",
      );
      downloadStarted.resolve();
    } else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const secrets: TerminalSecrets = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
  let current = true;
  const guard = () => {
    if (!current) throw new Error("OWNER_CHANGED");
  };
  const open = async () => {
    const models = new TerminalModelConfig(root, secrets, async () => ({
      authenticated: false,
    }));
    await models.open();
    const host = new TerminalLocalModels({
      root,
      models,
      assertCurrent: guard,
      changed() {},
      log: { info() {}, warn() {} },
      deps: {
        fetchImpl: (url, init) =>
          fetch(
            `http://127.0.0.1:${port}${new URL(String(url)).pathname}`,
            init,
          ),
        streamPull: (name, onEvent, signal) =>
          streamOllamaPull(name, onEvent, signal, port),
        modelsDir: () => path.join(root, "models"),
      },
    });
    cleanup.push(() => host.close());
    const registry = new RemoteResourceRegistry();
    host.register(registry);
    const context = { controllerDeviceId: "controller", assertCurrent: guard };
    const client: TerminalClient = {
      invoke: (async (
        channel: string,
        args: unknown[] = [],
        device?: string,
      ) => {
        expect(device).toBe("selected-server");
        const request = args[0] as never;
        return channel.endsWith(":manifest")
          ? registry.manifest(context, request)
          : channel.endsWith(":list")
            ? registry.list(context, request)
            : channel.endsWith(":get")
              ? registry.get(context, request)
              : registry.invoke(context, request);
      }) as TerminalClient["invoke"],
      subscribe: () => () => {},
      close() {},
    };
    const command = (
      operation: string,
      id = "ollama",
      input?: Record<string, unknown>,
    ) =>
      runResourceCommand(client, {
        collection: "local-models",
        operation,
        id,
        input,
        locale: "en",
        device: "selected-server",
      });
    const state = async (id = "ollama") =>
      ((await command("get", id)) as RemoteResource).blocks![0].data as {
        job?: LocalModelJob;
        progress?: { phase: string };
      };
    return { host, models, command, state, client };
  };
  let f = await open();
  await f.command("start");
  await vi.waitFor(
    async () => expect((await f.state()).job?.state).toBe("completed"),
    { interval: 1 },
  );
  expect(
    f.models
      .snapshot()
      .providers.find((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID)?.runtimes.pi
      ?.models,
  ).toEqual([]);
  await f.models.prepareLocalModel(MANAGED_OLLAMA_PROVIDER_ID);
  const name = "fixture-tools:latest";
  await f.command("download", "ollama", { name });
  await downloadStarted.promise;
  f.client.close(); // There is no controller lifetime attached to the host job.
  await f.command("pause", name);
  await vi.waitFor(
    async () => expect((await f.state(name)).job?.state).toBe("paused"),
    { interval: 1 },
  );
  await f.host.close();
  f = await open();
  expect((await f.state(name)).progress?.phase).toBe("paused");
  downloadStarted = deferred();
  await f.command("resume", name);
  await downloadStarted.promise;
  installed.add(name);
  downloads.get(name)!.end(JSON.stringify({ status: "success" }) + "\n");
  await vi.waitFor(
    async () => expect((await f.state(name)).job?.state).toBe("completed"),
    { interval: 1 },
  );
  const provider = f.models
    .snapshot()
    .providers.find((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID)!;
  for (const engine of ["pi", "codex", "claude-code"] as const)
    expect(provider.runtimes[engine]?.models.map((m) => m.id)).toContain(name);
  await f.command("disable", name);
  await vi.waitFor(
    async () => expect((await f.state(name)).job?.state).toBe("completed"),
    { interval: 1 },
  );
  expect(
    (await f.models.views())
      .find((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID)
      ?.models.pi?.find((m) => m.id === name)?.disabled,
  ).toBe(true);
  await f.host.close();
  f = await open();
  expect(
    (await f.models.views())
      .find((p) => p.id === MANAGED_OLLAMA_PROVIDER_ID)
      ?.models.pi?.find((m) => m.id === name)?.disabled,
  ).toBe(true);
  await f.command("enable", name);
  await vi.waitFor(
    async () => expect((await f.state(name)).job?.state).toBe("completed"),
    { interval: 1 },
  );
  await f.command("delete", name);
  await vi.waitFor(
    async () => expect((await f.state(name)).job?.state).toBe("completed"),
    { interval: 1 },
  );
  expect(installed.has(name)).toBe(false);
  downloadStarted = deferred();
  await f.command("download", "ollama", { name: "late-owner:latest" });
  await downloadStarted.promise;
  current = false;
  await f.host.close();
  expect(await readFile(path.join(root, "models.json"), "utf8")).not.toContain(
    "late-owner",
  );
  await expect(
    f.models.prepareLocalModel(MANAGED_OLLAMA_PROVIDER_ID),
  ).rejects.toThrow();
});

// Integration tier: verified Linux runtime archives must extract with bundled
// Node alone, preserving internal library links while rejecting traversal.
it("extracts zstd runtime archives without a system decompressor and rejects escaping links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-local-archive-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "runtime.tar.zst");
  const entry = (name: string, type: string, data = "", linkpath = "") => {
    const header = new tar.Header({
      path: name,
      type: type as "File",
      size: Buffer.byteLength(data),
      mode: 0o755,
      linkpath,
    });
    header.encode();
    return Buffer.concat([
      Buffer.from(header.block!),
      Buffer.from(data),
      Buffer.alloc((512 - (Buffer.byteLength(data) % 512)) % 512),
    ]);
  };
  await writeFile(
    archive,
    zstdCompressSync(
      Buffer.concat([
        entry("bin/ollama", "File", "#!/bin/sh\n"),
        entry("lib/runtime.so", "File", "library"),
        entry("lib/current.so", "SymbolicLink", "", "runtime.so"),
        Buffer.alloc(1024),
      ]),
    ),
  );
  const destination = path.join(root, "good");
  expect(await extractLinuxOllama(archive, destination)).toBe(
    path.join(destination, "bin", "ollama"),
  );
  expect(
    await readFile(path.join(destination, "lib", "current.so"), "utf8"),
  ).toBe("library");
  await writeFile(
    archive,
    zstdCompressSync(
      Buffer.concat([
        entry("escape", "SymbolicLink", "", "../outside"),
        entry("bin/ollama", "File", "bad"),
        Buffer.alloc(1024),
      ]),
    ),
  );
  await expect(
    extractLinuxOllama(archive, path.join(root, "bad")),
  ).rejects.toThrow("unsafe_archive_path");
});
