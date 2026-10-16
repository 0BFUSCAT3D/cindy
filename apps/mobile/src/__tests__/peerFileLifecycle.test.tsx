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
  reset: undefined as any,
  commands: [] as any[],
  rpc: vi.fn(),
  open: vi.fn(),
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
          const result =
            message.action === "invoke"
              ? JSON.stringify({ ok: true, result: "preview" })
              : message.action === "stats"
                ? JSON.stringify({ path: "relay" })
                : "v=0";
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
  },
  File: class {},
  Paths: { cache: "/cache" },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${++state.sequence}` }));
vi.mock("@/device-link/peerFileCache", () => ({
  createPeerFileCache: async () => null,
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
vi.mock("@/device-link/peerFileRegistry", () => ({
  installPeerFileDownload: () => () => {},
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
  clearPeerMedia() {},
  recordPeerMedia() {},
  canStagePeerMedia: () => true,
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
