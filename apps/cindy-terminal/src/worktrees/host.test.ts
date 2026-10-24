import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  access,
  realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createTerminalWorktrees, type TerminalWorktrees } from "./host.js";
import { TerminalTaskStorage } from "../tasks/storage.js";
import { TerminalSecretStore } from "../secrets.js";
import { createWorktreeRuntimeLeases } from "@cindy/worktree-core/runtimeLeases";
import { createWorktreeResourceLocks } from "@cindy/worktree-core/resourceLock";
import {
  readDesktopProcessIdentity,
  isReusedDesktopInstancePid,
} from "@cindy/worktree-core/processIdentity";
import { withCrossProcessLock } from "@cindy/remote-agent/crossProcessLock";
import { readTerminalWorktreeReferences } from "@cindy/worktree-core/terminalReferences";

const exec = promisify(execFile);
const fixtures: Array<{
  root: string;
  hosts: TerminalWorktrees[];
  secrets: TerminalSecretStore;
}> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const host of f.hosts) host.close();
    await f.secrets.flush();
    f.secrets.lock();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "terminal-worktree-host-")),
  );
  const profile = path.join(root, "profile"),
    owner = path.join(profile, "owners", "a".repeat(32)),
    appDataRoot = path.join(root, "app-data");
  const tasks = new TerminalTaskStorage(path.join(owner, "tasks"));
  await tasks.open();
  const secrets = new TerminalSecretStore(profile);
  await secrets.open();
  await secrets.initialize("machine");
  const f = { root, hosts: [] as TerminalWorktrees[], secrets };
  fixtures.push(f);
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  const create = async () => {
    const host = await createTerminalWorktrees({
      root: owner,
      profile,
      appDataRoot,
      tasks,
      secrets,
      logger,
      guard() {},
      readSessionTransfer: async () => undefined,
    });
    f.hosts.push(host);
    return host;
  };
  const host = await create();
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = async (cwd: string, ...args: string[]) =>
    (
      await exec("git", args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(root, "git-global"),
          GIT_CONFIG_NOSYSTEM: "1",
        },
      })
    ).stdout.trim();
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Worktree Test");
  await git(repo, "config", "user.email", "worktree-test@localhost");
  await git(repo, "config", "core.autocrlf", "false");
  await writeFile(path.join(repo, "tracked.txt"), "base\n");
  await writeFile(path.join(repo, ".gitignore"), ".env\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "fixture");
  await tasks.create({
    id: "task",
    agentKind: "claude-code",
    model: "fixture",
    title: "Task",
    workDir: repo,
  });
  const result = await host.manager.createWorktree({
    sessionId: "task",
    baseRepo: repo,
    name: "terminal",
    sourceBranch: "main",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  await tasks.update("task", { workDir: result.meta.path });
  return {
    ...f,
    host,
    owner,
    appDataRoot,
    tasks,
    create,
    git,
    meta: result.meta,
  };
}

/** Integration tier: the terminal previously had no production worktree host.
 * Exercise its actual registry, encrypted vault, bundled worker and Git, then
 * reopen the host before restoring staged, unstaged, ignored and binary data. */
it("recovers a real terminal worktree after host restart using the packaged Node archive worker", async () => {
  const f = await fixture();
  await writeFile(path.join(f.meta.path, "tracked.txt"), "staged\n");
  await f.git(f.meta.path, "add", "tracked.txt");
  await writeFile(path.join(f.meta.path, "tracked.txt"), "unstaged\n");
  await writeFile(path.join(f.meta.path, ".env"), "private fixture value\n");
  await writeFile(
    path.join(f.meta.path, "binary.dat"),
    Buffer.from([0, 255, 1, 128]),
  );
  await f.tasks.update("task", { archived: true });
  await f.host.recycle.requestWorktreeRecycle("task");
  await f.host.manager.removeWorktreeForSession("task", {
    canRemove: async () => Boolean((await f.tasks.get("task"))?.archived),
  });
  await expect(access(f.meta.path)).rejects.toMatchObject({ code: "ENOENT" });
  const record = await f.host.journal.readRecycleRecord(f.meta.path);
  expect(record?.archive?.encryptedKey).toMatch(/^terminal:v1:/);
  expect(
    await readFile(path.join(f.secrets.directory, "secrets.enc"), "utf8"),
  ).not.toContain(f.secrets.getSync("worktree:recovery-key"));
  f.host.close();
  const restarted = await f.create();
  expect(
    await restarted.restore.getWorktreeRestoreStatus("task"),
  ).toMatchObject({ state: "restorable" });
  expect(
    await restarted.restore.restoreWorktreeForSession("task"),
  ).toMatchObject({ ok: true, snapshotApplied: true });
  expect(await readFile(path.join(f.meta.path, "tracked.txt"), "utf8")).toBe(
    "unstaged\n",
  );
  expect(await f.git(f.meta.path, "show", ":tracked.txt")).toBe("staged");
  expect(await readFile(path.join(f.meta.path, ".env"), "utf8")).toBe(
    "private fixture value\n",
  );
  expect(await readFile(path.join(f.meta.path, "binary.dat"))).toEqual(
    Buffer.from([0, 255, 1, 128]),
  );
});

/** Safety tier: a released GUI must see the Node host's v1 runtime lease, and
 * newer readers must retain inactive task references across owner profiles. */
it("exposes native occupancy to the existing GUI lease reader and preserves unreadable task references", async () => {
  const f = await fixture();
  const guiRoot = path.join(f.appDataRoot, "CindyGlobal");
  await mkdir(path.join(guiRoot, ".dev-instances"), { recursive: true });
  const gui = createWorktreeRuntimeLeases({
    ...createWorktreeResourceLocks({ withCrossProcessLock }),
    userDataRoot: () => guiRoot,
    appDataRoot: () => f.appDataRoot,
    readDesktopProcessIdentity,
    isReusedDesktopInstancePid,
    notifyWorktreeRecycleOpportunity() {},
    isGitProcessTreeAlive: async () => false,
  });
  // The retained task remains visible even with no native process running.
  expect(await gui.readWorktreeRuntimePaths()).toContain(f.meta.path);
  f.host.close();
  expect(await gui.readWorktreeRuntimePaths()).toContain(f.meta.path);
  const before = await readFile(path.join(f.owner, "worktree-task-references.json"), "utf8");
  await f.create();
  expect(await readFile(path.join(f.owner, "worktree-task-references.json"), "utf8")).toBe(before);
  const lease = await f.host.runtime.acquireWorktreeRuntimeLease(
    "task",
    f.meta.path,
  );
  expect(lease).not.toBeNull();
  expect(await gui.readWorktreeRuntimePaths()).toContain(f.meta.path);
  await f.tasks.update("task", { archived: true });
  await f.host.manager.removeWorktreeForSession("task", {
    canRemove: async () => true,
  });
  await access(f.meta.path);
  await f.host.runtime.releaseWorktreeRuntimeLease(lease!);
  expect(await gui.readWorktreeRuntimePaths()).not.toContain(f.meta.path);
  expect(readTerminalWorktreeReferences(f.appDataRoot).rows).toContainEqual(
    expect.objectContaining({
      id: "task",
      worktreePath: f.meta.path,
      currentDatabase: false,
    }),
  );
  await writeFile(path.join(f.owner, "tasks", "task", "task.json"), "{bad");
  await expect(
    f.host.references.readLocalWorktreeReferences(),
  ).rejects.toThrow();
  await f.host.manager.removeWorktreeForSession("task", {
    canRemove: async () => true,
  });
  await access(f.meta.path);
});
