import { expect, it } from "vitest";
import {
  createFileTransferWatchdog,
  filePeerReuseMs,
  fileTransferPath,
  FILE_PEER_COMMAND_TIMEOUT_MS,
  FILE_PEER_RECEIVE_TIMEOUT_MS,
} from "../fileTransferPolicy";

it("uses the advertised lifetime minus a command budget, rejecting invalid capabilities", () => {
  expect(filePeerReuseMs(undefined, true)).toBeNull();
  expect(filePeerReuseMs(300_000, 'true')).toBe(285_000);
  expect(filePeerReuseMs(300_000)).toBe(285_000);
  expect(filePeerReuseMs(60_000)).toBe(45_000);
  for (const value of [undefined, NaN, Infinity, -1])
    expect(filePeerReuseMs(value)).toBe(30_000);
});
it("does not abandon a modest relay transfer just because its KB/s is low", () => {
  let time = 0;
  const watch = createFileTransferWatchdog(4_000_000, "relay", () => time);
  for (time = 1000; time <= 25_000; time += 1000)
    expect(watch(time * 150)).toBeNull();
  expect(fileTransferPath('{"path":"relay","rttMs":300}')).toBe("relay");
  expect(fileTransferPath("invalid")).toBe("unknown");
});
it("uses remaining completion time on known paths instead of separate arbitrary speed floors", () => {
  let time = 0;
  const paths = ["direct", "relay", "unknown"] as const;
  const watches = paths.map((path) =>
    createFileTransferWatchdog(20_000_000, path, () => time),
  );
  let outcomes: unknown[] = [];
  for (time = 1000; time <= FILE_PEER_COMMAND_TIMEOUT_MS; time += 1000)
    outcomes = watches.map((watch) => watch(time * 150));
  expect(outcomes).toEqual(["slow-direct", "slow-relay", null]);
});
it("isolates stalled peers and still detects a missing EOF after all bytes arrived", () => {
  let time = 0;
  const stalled = createFileTransferWatchdog(1_000_000, "direct", () => time);
  const healthy = createFileTransferWatchdog(1_000_000, "relay", () => time);
  for (time = 1000; time < FILE_PEER_COMMAND_TIMEOUT_MS; time += 1000) {
    expect(stalled(0)).toBeNull();
    expect(healthy(Math.min(time * 100, 1_000_000))).toBeNull();
  }
  expect(stalled(0)).toBe("stalled");
  time = 10_000 + FILE_PEER_COMMAND_TIMEOUT_MS;
  expect(healthy(1_000_000)).toBe("stalled");
});
it("discards the old sample when the actual route changes", () => {
  let time = 0;
  let path: "direct" | "relay" = "relay";
  const watch = createFileTransferWatchdog(
    100_000_000,
    () => path,
    () => time,
  );
  time = FILE_PEER_COMMAND_TIMEOUT_MS - 1;
  expect(watch(1_000_000)).toBeNull();
  path = "direct";
  time++;
  expect(watch(2_000_000)).toBeNull();
  time += FILE_PEER_COMMAND_TIMEOUT_MS;
  expect(watch(50_000_000)).toBeNull();
  expect(FILE_PEER_RECEIVE_TIMEOUT_MS).toBeGreaterThan(
    FILE_PEER_COMMAND_TIMEOUT_MS,
  );
});
