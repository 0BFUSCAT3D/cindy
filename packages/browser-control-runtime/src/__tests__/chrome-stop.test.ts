import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  stopOpenClawChrome,
  type RunningChrome,
} from "../_generated/extension/src/browser/chrome.js";

/**
 * Regression: stop treated ChildProcess.killed (signal sent) as process exit,
 * immediately SIGKILLing Chrome before it could flush login data. Existing
 * launch tests never exercise shutdown. A live fake process after SIGTERM is
 * the minimal input; unit tier uses virtual time, no real process or profile.
 */
function runningChrome(alreadySignalled = false) {
  const proc = {
    killed: alreadySignalled,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal: NodeJS.Signals) => {
      proc.killed = true;
      return true;
    }),
  };
  const release = vi.fn();
  const running: RunningChrome = {
    pid: 123,
    exe: { kind: "chrome", path: "/fake/chrome" },
    userDataDir: "/fake/profile",
    cdpPort: 18800,
    startedAt: 0,
    proc: proc as unknown as ChildProcessWithoutNullStreams,
    releaseCdpProxyBypass: release,
  };
  return { running, proc, release };
}

afterEach(() => vi.useRealTimers());

describe("managed Chrome shutdown", () => {
  it.each([false, true])(
    "waits for process exit with an earlier signal=%s",
    async (alreadySignalled) => {
      vi.useFakeTimers();
      const { running, proc, release } = runningChrome(alreadySignalled);
      let settled = false;
      const stopping = stopOpenClawChrome(running, 100).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      expect(release).not.toHaveBeenCalled();
      expect(proc.kill.mock.calls).toEqual(
        alreadySignalled ? [] : [["SIGTERM"]],
      );

      proc.exitCode = 0;
      await vi.advanceTimersByTimeAsync(50);
      await stopping;
      expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("force-stops an unresponsive process only after the grace period", async () => {
    vi.useFakeTimers();
    const { running, proc, release } = runningChrome();
    const stopping = stopOpenClawChrome(running, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(proc.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("recognizes an exit caused by a signal and does not signal again", async () => {
    const { running, proc, release } = runningChrome();
    proc.signalCode = "SIGTERM";
    await stopOpenClawChrome(running, 100);
    expect(proc.kill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
