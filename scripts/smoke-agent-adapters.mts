/**
 * Explicit native acceptance, outside unit/CI: uses the selected Agent's own existing login.
 * node --import tsx scripts/smoke-agent-adapters.mts --agent cursor [--send] [--executable /absolute/cli]
 * Default: discover/create/close. --send adds two small real prompts and cancellation (native usage applies).
 * --tools additionally exercises native reads/writes, command execution and permission denial.
 * Only this explicit manual mode approves allow_once choices for its temporary test workspace.
 * Runs only in a unique temp workspace. Never prints native output, account identity or diagnostics.
 * Does not enable Cindy's feature flag, install a CLI, or read/change its credential files.
 */
import {
  access,
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type NativeAgentDefinition,
} from "../apps/desktop/src/main/agent-adapters/acp.js";
import { createNativeAgentAdapter } from "../apps/desktop/src/main/agent-adapters/native.js";
import { NATIVE_AGENT_DEFINITIONS } from "../apps/desktop/src/main/agent-adapters/definitions.js";
import { createAgentAdapterRuntime } from "../apps/desktop/src/main/agent-adapters/runtime.js";
import {
  createAdapterSessionService,
  type AdapterRunView,
} from "../apps/desktop/src/main/agent-adapters/sessions.js";
import {
  agentResourceRef,
  createAgentResourceProvider,
} from "../apps/desktop/src/main/agent-adapters/resources.js";

class SmokeError extends Error {}
const arg = (key: string) => {
  const at = process.argv.indexOf(key);
  return at < 0 ? undefined : process.argv[at + 1];
};
const name = arg("--agent");
if (!name || !Object.hasOwn(NATIVE_AGENT_DEFINITIONS, name)) {
  process.stderr.write(
    `Use --agent ${Object.keys(NATIVE_AGENT_DEFINITIONS).join("|")}; --send additionally uses the native model.\n`,
  );
  process.exit(2);
}
const selected = name as keyof typeof NATIVE_AGENT_DEFINITIONS;
let definition: NativeAgentDefinition = NATIVE_AGENT_DEFINITIONS[selected];
let env = process.env;
const executable = arg("--executable");
if (executable) {
  if (!path.isAbsolute(executable))
    throw new SmokeError("absolute-executable-required");
  // A local manual-test input, never exposed through app IPC or remote resources.
  definition = {
    ...definition,
    executables: [path.basename(executable).replace(/\.exe$/i, "")],
    homeBin: undefined,
    homeOnly: false,
  };
  env = { ...process.env, PATH: path.dirname(executable) };
  // The official launcher may need system commands; retain the user's path after the selected directory.
  env.PATH += path.delimiter + (process.env.PATH ?? process.env.Path ?? "");
}
const workspace = await mkdtemp(
  path.join(tmpdir(), "cindy-native-agent-smoke-"),
);
const controller = "native-smoke";
const client = {
  protocolVersion: 1,
  primitives: ["text", "form"],
  locale: "en",
};
const context = { controllerDeviceId: controller };
const started = Date.now();
let phase = "discover";
let runId = "";
let textEvents = 0;
let toolEvents = 0;
let reply = "";
let cancel: Promise<unknown> | undefined;
let interrupted = false;
let deniedPermissions = 0;
let allowedPermissions = 0;
const executedTools = new Set<string>();
const report = (status: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(
    JSON.stringify({
      agent: name,
      phase,
      status,
      elapsedMs: Date.now() - started,
      ...extra,
    }) + "\n",
  );
const adapter = createNativeAgentAdapter(definition, {
  env,
  requestTimeoutMs: 30_000,
  accessFile: executable
    ? async (candidate, mode) => {
        // An explicit version comparison must not fall back to another installed CLI.
        if (path.resolve(candidate) !== path.resolve(executable))
          throw new SmokeError("unexpected-executable");
        await access(candidate, mode);
      }
    : undefined,
});
const runtime = createAgentAdapterRuntime({
  enabled: true,
  agentAdapters: [
    {
      ...adapter,
      async start(request) {
        const session = await adapter.start(request);
        session.onEvent((event) => {
          if (event.type === "tool") {
            toolEvents++;
            const tool = event.data as
              { id?: string; kind?: string } | undefined;
            if (tool?.kind === "execute" && tool.id) executedTools.add(tool.id);
          }
          if (event.type !== "text") return;
          const data = event.data as
            { text?: unknown; thought?: boolean } | undefined;
          if (data?.thought || typeof data?.text !== "string") return;
          textEvents++;
          if (phase === "send") reply = (reply + data.text).slice(-64_000);
          if (phase === "cancel" && !cancel) {
            cancel = invoke("stop", runId);
            void cancel.catch(() => {});
          }
        });
        return session;
      },
    },
  ],
});
const service = createAdapterSessionService({
  runtime,
  isCurrent: () => true,
  isControllerAllowed: (id) => id === controller,
  listWorkspaces: async () => [
    { id: "smoke", label: "Smoke", root: workspace },
  ],
  validateWorkspace: realpath,
});
const resources = createAgentResourceProvider({
  enabled: () => true,
  service: () => service,
  guard: (id) => () => {
    if (id !== controller) throw new SmokeError("wrong-controller");
  },
});
const invoke = (
  actionId: string,
  id: string,
  input: Record<string, unknown> = {},
) =>
  resources.invoke!(context, {
    client,
    collectionId: "agent-adapters",
    resourceRef: agentResourceRef(id),
    actionId,
    input,
  });
let cleanup: Promise<void> | undefined;
const cleanUp = () =>
  (cleanup ??= (async () => {
    await service.dispose();
    runtime.dispose();
    await rm(workspace, { recursive: true, force: true });
  })());
const interrupt = (signal: NodeJS.Signals) => {
  interrupted = true;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  void cleanUp().catch(() => {});
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function waitFor(
  accept: (run: AdapterRunView) => boolean,
  timeoutMs: number,
): Promise<AdapterRunView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) throw new SmokeError("interrupted");
    const run = service.get(controller, runId);
    if (run.state === "failed")
      throw new SmokeError(run.error ?? "native-failed");
    if (run.permissions.length) {
      for (const permission of run.permissions) {
        const once = permission.options.find(
          (option) => option.kind === "allow_once",
        );
        if (phase === "tools-allow" || phase === "tools-command") {
          // A bounded manual test policy, never used by the app. Persistent grants
          // and Agents without an explicit one-time choice are not auto-approved.
          if (!once || allowedPermissions >= 8)
            throw new SmokeError("no-bounded-tool-approval");
          await invoke("permission:" + permission.id, runId, {
            optionId: once.id,
          });
          allowedPermissions++;
        } else {
          await invoke("deny:" + permission.id, runId);
          if (phase === "tools-deny") deniedPermissions++;
        }
      }
    }
    if (accept(run)) return run;
    if (run.state === "closed") throw new SmokeError("native-closed");
    await delay(50);
  }
  throw new SmokeError("smoke-timeout");
}
try {
  const catalog = await resources.get!(context, {
    client,
    ref: agentResourceRef("catalog"),
  });
  const available =
    catalog.actions
      ?.find((action) => action.id === "start")
      ?.fields?.find((field) => field.id === "instanceId")?.options ?? [];
  if (!available.some((option) => option.value === selected + ":local"))
    throw new SmokeError("not-installed");
  report("passed");
  phase = "create";
  const response = await invoke("start", "catalog", {
    requestId: "smoke-create",
    instanceId: selected + ":local",
    workspaceId: "smoke",
  });
  const navigation = response.effects.find(
    (effect) => effect.kind === "navigate",
  );
  if (navigation?.kind !== "navigate" || navigation.target.kind !== "resource")
    throw new SmokeError("missing-run");
  runId = navigation.target.ref.id;
  await waitFor(
    (run) => run.state === "idle",
    Math.max(100_000, (definition.authenticateTimeoutMs ?? 0) + 60_000),
  );
  report("passed");
  if (process.argv.includes("--send") || process.argv.includes("--tools")) {
    phase = "send";
    await invoke("send", runId, {
      requestId: "smoke-message",
      text: "Reply with exactly CINDY_NATIVE_SMOKE_OK. Do not use tools, access files, or run commands.",
    });
    await waitFor((run) => run.state === "idle", 60_000);
    if (!textEvents || reply.trim() !== "CINDY_NATIVE_SMOKE_OK")
      throw new SmokeError("unexpected-response");
    if (toolEvents) throw new SmokeError("unexpected-tool-use");
    report("passed", { textEvents });
    phase = "cancel";
    await invoke("send", runId, {
      requestId: "smoke-cancel",
      text: "Count from 1 to 200, one number per line. Do not use tools, access files, or run commands.",
    });
    const stopped = await waitFor(
      (run) => !!cancel && ["idle", "closed"].includes(run.state),
      60_000,
    );
    await cancel;
    if (stopped.state !== "idle")
      throw new SmokeError("forced-close-after-cancel");
    report("passed", { cooperative: true });
  }
  if (process.argv.includes("--tools")) {
    phase = "tools-deny";
    await invoke("send", runId, {
      requestId: "smoke-denied-write",
      text: "Use your file editing tool to create denied.txt containing DENIED_WRITE in the current workspace. Attempt once only. If approval is denied, stop and reply DECLINED. Do not work around a denial. Do not access any other files or run commands.",
    });
    await waitFor((run) => run.state === "idle", 60_000);
    const deniedExists = await access(path.join(workspace, "denied.txt")).then(
      () => true,
      () => false,
    );
    if (deniedPermissions) {
      if (deniedExists) throw new SmokeError("denied-file-was-written");
      report("passed", { deniedPermissions });
    } else {
      // Some Agents natively allow workspace edits. Keep the run non-passing
      // for permission acceptance, but still verify their actual file/command tools.
      process.exitCode = 1;
      report("unverified", { code: "native-permission-not-requested" });
    }

    phase = "tools-allow";
    const proof = "CINDY_FILE_PROOF_" + randomUUID();
    await writeFile(path.join(workspace, "input.txt"), proof + "\n");
    await invoke("send", runId, {
      requestId: "smoke-allowed-write",
      text: "Read input.txt in the current workspace using your file tool, then create approved.txt with exactly the same contents using your file editing tool. This new operation is approved for this test workspace. Do not touch denied.txt, any other files, or run commands.",
    });
    await waitFor((run) => run.state === "idle", 60_000);
    const copied = await readFile(
      path.join(workspace, "approved.txt"),
      "utf8",
    ).catch(() => "");
    if (copied.trim() !== proof)
      throw new SmokeError("native-file-tool-unverified");
    report("passed", { allowedPermissions });

    phase = "tools-command";
    const beforeCommands = executedTools.size;
    const command =
      process.platform === "win32"
        ? `powershell -NoProfile -Command "[System.IO.File]::WriteAllText('command.txt', 'CINDY_COMMAND_OK')"`
        : "printf CINDY_COMMAND_OK > command.txt";
    await invoke("send", runId, {
      requestId: "smoke-command",
      text: `Use your native terminal/shell tool to run exactly: ${command}\nRun only in the current workspace. Do not use a file editing tool to create this file, do not access any other files, and do not run other commands.`,
    });
    await waitFor((run) => run.state === "idle", 60_000);
    const commandResult = await readFile(
      path.join(workspace, "command.txt"),
      "utf8",
    ).catch(() => "");
    if (
      commandResult !== "CINDY_COMMAND_OK" ||
      executedTools.size <= beforeCommands
    )
      throw new SmokeError("native-command-tool-unverified");
    report("passed", { executedTools: executedTools.size - beforeCommands });
  }
  phase = "close";
  await invoke("close", runId);
  report("passed");
} catch (error) {
  report("failed", {
    code: interrupted
      ? "interrupted"
      : error instanceof SmokeError
        ? error.message
        : "host-error",
  });
  process.exitCode ||= 1;
} finally {
  try {
    await cleanUp();
  } catch {
    report("failed", { code: "cleanup-failed" });
    process.exitCode ||= 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
