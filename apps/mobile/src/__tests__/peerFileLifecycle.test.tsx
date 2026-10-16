// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PeerFileTransport } from "@/device-link/peerFileTransport";

const state = vi.hoisted(() => ({
  props: {} as any,
  sequence: 0,
  sessionBound: true,
  app: "active",
  change: (_state: string) => {},
  upload: undefined as any,
  read: undefined as any,
  download: undefined as any,
  cache: { read: vi.fn(), store: vi.fn(), prune: vi.fn(), invalidate: vi.fn() },
  deleted: vi.fn(),
  reset: undefined as any,
  commands: [] as any[],
  rpc: vi.fn(),
  open: vi.fn(),
  stats: vi.fn(),
  holdReceive: false,
  debug: false,
  log: vi.fn(),
}));
vi.mock("@/debug/mobileDebugLog", () => ({
  mobileDebugEnabled: () => state.debug,
  mobileDebugLog: state.log,
}));
vi.mock("react-native", () => ({
  View: ({ children }: any) => children,
  AppState: {
    get currentState() {
      return state.app;
    },
    addEventListener: (_: string, callback: typeof state.change) => {
      state.change = callback;
      return { remove() {} };
    },
  },
}));
vi.mock("react-native-webview", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    WebView: forwardRef((props: any, ref) => {
      state.props = props;
      useImperativeHandle(ref, () => ({
        injectJavaScript(script: string) {
          const match = /^window.filePeerMessage\((.*)\);true;$/.exec(script);
          if (!match) return;
          const message = JSON.parse(match[1]);
          state.commands.push(message);
          if (message.action === "receive" && state.holdReceive) return;
          const result =
            message.action === "invoke"
              ? JSON.stringify({ ok: true, result: "preview" })
              : message.action === "stats"
                ? state.stats()
                : "v=0";
          if (result === undefined) return;
          props.onMessage({
            nativeEvent: {
              data: JSON.stringify({
                type: "reply",
                id: message.id,
                ok: true,
                result,
              }),
            },
          });
        },
      }));
      return null;
    }),
  };
});
vi.mock("expo-file-system", () => ({
  Directory: class {
    exists = false;
    create() {}
  },
  File: class {
    uri = "/staging";
    exists = true;
    create() {}
    open() { return { close() {}, writeBytes() {} }; }
    delete() { this.exists = false; state.deleted(); }
  },
  Paths: { cache: "/cache", availableDiskSpace: 10 * 1024 ** 3 },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${++state.sequence}` }));
vi.mock("@/device-link/peerFileCache", () => ({
  createPeerFileCache: async () => state.cache,
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: "a" },
    accountGeneration: 1,
  }),
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({
    connectionEpoch: 1,
    invoke: state.rpc,
    openLink: state.open,
  }),
}));
vi.mock("@/config/env", () => ({
  DEVICE_LINK_API_BASE_URL: "https://example.test",
  getActiveMobileSessionRealm: () => "global",
}));
vi.mock("@cindy/device-link", async (original) => ({
  ...(await original<typeof import("@cindy/device-link")>()),
  resolveDesktopIceServers: async () => [],
}));
vi.mock("@/device-link/peerFileRegistry", async (original) => ({
  ...(await original<typeof import("@/device-link/peerFileRegistry")>()),
  installPeerFileDownload: (callback: any) => {
    state.download = callback;
    return () => { state.download = undefined; };
  },
  installPeerInvoke: (callback: any) => {
    state.read = callback;
    return () => {
      state.read = undefined;
    };
  },
  installPeerUpload: (callback: any) => {
    state.upload = callback;
    return () => {
      state.upload = undefined;
    };
  },
  installPeerUploadProbe: () => () => {},
  installPeerReset: (callback: any) => {
    state.reset = callback;
    return () => {
      state.reset = undefined;
    };
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const message = (value: unknown) =>
  state.props.onMessage({ nativeEvent: { data: JSON.stringify(value) } });
const read = () =>
  state.read("device", "file-browser:remote-op", [{ op: "readFile" }]);
// Exercise setup only: this peer supports downloads/RPC but declines attachment uploads.
const connect = () =>
  state.upload("device", "/unused", { size: 1, sha256: "a".repeat(64) });
const offers = () =>
  state.rpc.mock.calls.filter(([, , [r]]) => r.action === "offer");
const closes = () =>
  state.rpc.mock.calls.filter(([, , [r]]) => r.action === "close");
beforeEach(() => {
  vi.useFakeTimers();
  state.sequence = 0;
  state.sessionBound = true;
  state.app = "active";
  state.commands = [];
  state.holdReceive = false;
  state.debug = false;
  state.log.mockClear();
  state.stats.mockReset().mockReturnValue(JSON.stringify({ path: "relay" }));
  state.deleted.mockClear();
  state.cache.read.mockReset().mockResolvedValue(null);
  state.cache.store.mockReset().mockResolvedValue(undefined);
  state.cache.prune.mockReset().mockResolvedValue(true);
  state.open.mockReset().mockResolvedValue(undefined);
  state.rpc
    .mockReset()
    .mockImplementation(async (_device, _channel, [request]) =>
      request.action === "caps"
        ? {
            version: 1,
            streaming: true,
            idleMs: 300_000,
            ...(state.sessionBound ? { sessionBound: true } : {}),
          }
        : request.action === "open"
          ? { ticket: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", size: 0, mimeType: "text/html", version: "a".repeat(64) }
        : { connection: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sdp: "v=0" },
    );
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(PeerFileTransport)));
  act(() => message({ type: "ready" }));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("opens lazily, keeps negotiated connection idle and releases the host on background", async () => {
  expect(await read()).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
  await connect();
  expect(offers()[0][2][0].sessionBound).toBe(true);
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(closes()).toHaveLength(0);
  expect(await read()).toEqual({ ok: true, result: "preview" });
  expect(offers()).toHaveLength(1);
  act(() => {
    state.app = "background";
    state.change("background");
  });
  expect(closes()).toHaveLength(1);
  expect(state.read).toBeUndefined();
  act(() => {
    state.app = "active";
    state.change("active");
  });
  act(() => message({ type: "ready" }));
  expect(await read()).toBeNull();
  expect(offers()).toHaveLength(1);
  await connect();
  expect(offers()).toHaveLength(2);
});

it("keeps legacy idle expiry when the host has not advertised sessionBound", async () => {
  state.sessionBound = false;
  await connect();
  expect(offers()[0][2][0]).not.toHaveProperty("sessionBound");
  await vi.advanceTimersByTimeAsync(300_000);
  expect(closes()).toHaveLength(1);
  expect(await read()).toBeNull();
});

it("releases a late host answer after backgrounding during setup", async () => {
  const normal = state.rpc.getMockImplementation()!;
  let answer!: (value: unknown) => void;
  state.rpc.mockImplementation((...args) =>
    args[2][0].action === "offer"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : normal(...args),
  );
  const transfer = connect();
  const cancelled = expect(transfer).rejects.toThrow("FILE_PEER_CANCELLED");
  await vi.waitFor(() => expect(offers()).toHaveLength(1));
  act(() => {
    state.app = "background";
    state.change("background");
  });
  answer({ connection: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", sdp: "v=0" });
  await cancelled;
  expect(closes()).toHaveLength(1);
  expect(state.commands.some((c) => c.action === "answer")).toBe(false);
});

it("rebuilds only on demand after failure and ignores delayed closure of the old connection", async () => {
  await connect();
  const id = state.commands.find((c) => c.action === "offer").args[0];
  act(() => message({ type: "closed", connection: id }));
  expect(await read()).toBeNull();
  await connect();
  expect(offers()).toHaveLength(2);
  act(() => message({ type: "closed", connection: id }));
  expect(await read()).toEqual({ ok: true, result: "preview" });
  act(() => state.reset("device"));
  expect(await read()).toBeNull();
});

it.each([
  ["background", false], ["reset", false], ["abort", false],
  ["background", true], ["reset", true], ["abort", true],
] as const)("rejects and releases a file cancelled during cache store: %s, store fails=%s", async (cause, fails) => {
  let resume!: () => void;
  state.cache.store.mockImplementation(() => new Promise<void>((resolve, reject) => {
    resume = () => fails ? reject(new Error("cache unavailable")) : resolve();
  }));
  const controller = new AbortController();
  const pending = state.download("device", "url", controller.signal, 1,
    { size: 0, mimeType: "text/html", version: "a".repeat(64) });
  const cancelled = expect(pending).rejects.toThrow("FILE_PEER_CANCELLED");
  await vi.waitFor(() => expect(state.cache.store).toHaveBeenCalledTimes(1));
  act(() => {
    if (cause === "background") {
      state.app = "background";
      state.change("background");
    } else if (cause === "reset") state.reset("device");
    else controller.abort();
  });
  resume();
  await cancelled;
  expect(state.deleted).toHaveBeenCalledTimes(1);
});

it("returns a cache hit without reserving space for another transfer", async () => {
  const cached = { ossKey: "", size: 5, mimeType: "text/html" };
  state.cache.read.mockResolvedValue(cached);
  expect(await state.download("device", "url", undefined, 1, cached)).toBe(cached);
  expect(state.cache.prune).not.toHaveBeenCalled();
  expect(state.open).not.toHaveBeenCalled();
});

it("releases a cache hit invalidated just before its promise resumes", async () => {
  const { recordPeerMedia } = await import("@/device-link/peerFileRegistry");
  const cached = { ossKey: "", size: 5, mimeType: "text/html" };
  const dispose = vi.fn();
  state.cache.read.mockImplementation(async () => {
    recordPeerMedia(cached, "/cached-copy", dispose);
    state.reset("device");
    return cached;
  });
  await expect(state.download("device", "url")).rejects.toThrow("FILE_PEER_CANCELLED");
  expect(dispose).toHaveBeenCalledOnce();
  expect(state.open).not.toHaveBeenCalled();
});

it.each(["unknown", "timeout", "route-change", "debug-enabled"])("samples paths after %s and falls back despite steady progress", async (initial) => {
  state.holdReceive = true;
  state.debug = initial === "debug-enabled";
  const started = Date.now();
  if (initial === "route-change") {
    state.stats.mockImplementation(() => JSON.stringify({
      path: Date.now() - started < 8000 ? "direct" : "relay",
    }));
  } else {
    state.stats.mockReturnValueOnce(initial === "timeout" ? undefined : JSON.stringify({ path: "unknown" }));
  }
  const normal = state.rpc.getMockImplementation()!;
  state.rpc.mockImplementation((...args) => args[2][0].action === "open"
    ? Promise.resolve({ ticket: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", size: 100_000, mimeType: "text/html" })
    : normal(...args));
  const controller = new AbortController();
  let settled = false;
  const transfer = state.download("device", "url", controller.signal).then((result: unknown) => {
    settled = true;
    return result;
  });
  // Cleanup can reject the intentionally unfinished old implementation.
  void transfer.catch(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    const receive = state.commands.find((c) => c.action === "receive");
    expect(receive).toBeDefined();
    for (let offset = 0; offset < 26 && !settled; offset++) {
      act(() => message({ type: "write", id: `write-${offset}`, args: [receive.args[0], offset, "YQ=="] }));
      await vi.advanceTimersByTimeAsync(1000);
      // A route change must restart the rate sample instead of using old-path throughput.
      if (initial === "route-change" && offset === 15) expect(settled).toBe(false);
    }
    expect(settled).toBe(true);
    expect(await transfer).toBeNull();
    expect(state.stats.mock.calls.length).toBeGreaterThan(1);
    expect(state.log).toHaveBeenCalledWith("debug", "files", "slow transfer fallback", expect.objectContaining({ reason: "slow-relay", path: "relay" }));
    expect(state.log.mock.calls.some((c) => c[2] === "direct transfer progress")).toBe(state.debug);
    expect(state.deleted).toHaveBeenCalledOnce();
    const samples = state.stats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.stats).toHaveBeenCalledTimes(samples);
  } finally {
    controller.abort();
    await transfer.catch(() => {});
  }
});
