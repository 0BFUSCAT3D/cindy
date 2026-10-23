import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

// Every write still reconstructs the complete owner/SYSTEM-only DACL. Reuse
// the interpreter, not a cached security decision or a path-based ACL result.
const script = `
$ErrorActionPreference = 'Stop'
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Split(':', 2)
  if ($parts.Length -ne 2) { exit 1 }
  try {
    $directory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($owner)
    foreach ($sid in @($owner, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [System.IO.Directory]::SetAccessControl($directory, $acl)
    [Console]::Out.WriteLine($parts[0] + ':ok')
  } catch {
    [Console]::Out.WriteLine($parts[0] + ':error')
  }
  [Console]::Out.Flush()
}
`;
type Pending = {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type Worker = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, Pending>;
  idle?: NodeJS.Timeout;
};
let worker: Worker | undefined;

function keepAlive(current: Worker, needed: boolean) {
  if (needed) current.child.ref();
  else current.child.unref();
  for (const stream of current.child.stdio) {
    const handle = stream as unknown as { ref?(): void; unref?(): void } | null;
    if (needed) handle?.ref?.();
    else handle?.unref?.();
  }
}

function stop(current: Worker, error?: Error) {
  if (worker === current) worker = undefined;
  clearTimeout(current.idle);
  for (const pending of current.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error ?? new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED"));
  }
  current.pending.clear();
  if (error) current.child.kill();
  else current.child.stdin.end();
  keepAlive(current, false);
}

/** Paths are UTF-8 data on a private child pipe, never PowerShell source. The
 * worker exits on stdin EOF, after one idle second, or after any protocol error. */
export function restrictWindowsDirectory(
  directory: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!worker) {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, env, stdio: "pipe" },
    );
    const current: Worker = { child, pending: new Map() };
    worker = current;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.resume();
    child.on("error", () =>
      stop(current, new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED")),
    );
    child.stdin.on("error", () =>
      stop(current, new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED")),
    );
    child.on("exit", () => {
      lines.close();
      stop(current, new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED"));
    });
    lines.on("line", (line) => {
      const [id, status, extra] = line.split(":"),
        pending = current.pending.get(id);
      if (
        !pending ||
        extra !== undefined ||
        !["ok", "error"].includes(status)
      ) {
        stop(current, new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED"));
        return;
      }
      current.pending.delete(id);
      clearTimeout(pending.timer);
      if (status === "ok") pending.resolve();
      else pending.reject(new Error("PRIVATE_DIRECTORY_PERMISSIONS_FAILED"));
      if (!current.pending.size) {
        keepAlive(current, false);
        current.idle = setTimeout(() => stop(current), 1_000);
        current.idle.unref();
      }
    });
  }
  const current = worker;
  clearTimeout(current.idle);
  keepAlive(current, true);
  return new Promise<void>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(
      () => stop(current, new Error("PRIVATE_DIRECTORY_PERMISSIONS_TIMEOUT")),
      15_000,
    );
    current.pending.set(id, { resolve, reject, timer });
    current.child.stdin.write(
      `${id}:${Buffer.from(directory, "utf8").toString("base64")}\n`,
    );
  });
}
