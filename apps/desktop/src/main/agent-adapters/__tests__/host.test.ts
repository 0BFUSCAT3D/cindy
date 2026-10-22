import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_RESOURCE_GET_CHANNEL } from '@cindy/device-link';
import { AGENT_ADAPTER_IPC } from '../../../shared/agentAdapters.js';
import { remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { createAgentAdapterRuntime, type AgentAdapterRuntime } from '../runtime.js';
import { agentResourceRef } from '../resources.js';
import { registerAgentAdapterHost } from '../host.js';

/**
 * 测试价值：真实 host IPC 和资源注册入口；未授权 frame／伪造控制端不得启动进程或改设置。
 * 规则依据：Electron sender、owner 切换和远程撤权边界；现有 sessions 测试未覆盖生产接线。
 * 最小失败输入：未信任 sender、无 Device Link 上下文、目录选择 await 期间换账号。
 * tier：unit。只替换外部 Electron/DB/文件设置；实际 runtime/registry/service 保持生产实现。
 */
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  quits: [] as (() => Promise<void>)[],
  owner: 'owner:1',
  pending: false,
  enabled: false,
  customized: false,
  trusted: true,
  context: null as null | { controllerDeviceId: string; channel: string; sharedTask?: unknown },
  remoteEnabled: true,
  revoked: [] as string[],
  choose: vi.fn(async () => ({ canceled: false, filePaths: ['/fake/project'] })),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
  dialog: { showOpenDialog: () => state.choose() },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.owner,
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  getDeviceLinkInvokeContext: () => state.context,
}));
vi.mock('../../device-link/settings-store.js', () => ({
  readDeviceLinkSettings: () => ({
    remoteControlEnabled: state.remoteEnabled,
    revokedControllers: state.revoked,
  }),
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ listRecentWorkdirs: async () => [] }));
vi.mock('../../mcp-integrations/createProject.js', () => ({
  validateExistingLocalProjectDirectory: async (workingDir: string) => ({ ok: true, workingDir }),
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: () => {
    if (!state.trusted) throw new Error('PERMISSION_DENIED');
  },
}));
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string) => {
    throw new Error(code);
  },
}));
vi.mock('../../lifecycle.js', () => ({
  onQuit: (_name: string, fn: () => Promise<void>) => state.quits.push(fn),
}));
vi.mock('../settings.js', () => ({
  agentAdaptersEnabled: () => state.enabled,
  agentAdapterSettings: {
    readState: () => ({ isCustomized: state.customized }),
    writePatchAtomic: async ({ enabled }: { enabled: boolean }) => {
      state.enabled = enabled;
      state.customized = true;
    },
    resetAtomic: async () => {
      state.enabled = false;
      state.customized = false;
    },
  },
}));
let runtime: AgentAdapterRuntime | undefined;
const invoke = (channel: string, ...args: unknown[]) =>
  Promise.resolve().then(() => state.handlers.get(channel)!({}, ...args));
const client = { protocolVersion: 1, primitives: ['text'], locale: 'zh-CN' };
beforeEach(() => {
  state.owner = 'owner:1';
  state.enabled = false;
  state.customized = false;
  state.pending = false;
  state.trusted = true;
  state.remoteEnabled = true;
  state.revoked = [];
  state.context = null;
  state.choose.mockImplementation(async () => ({ canceled: false, filePaths: ['/fake/project'] }));
  registerAgentAdapterHost(() => {
    if (!runtime || runtime.signal.aborted || runtime.enabled !== state.enabled) {
      runtime?.dispose();
      runtime = createAgentAdapterRuntime({ enabled: state.enabled });
    }
    return runtime;
  });
});
afterEach(async () => {
  for (const quit of state.quits.splice(0)) await quit();
  runtime?.dispose();
  runtime = undefined;
  state.handlers.clear();
});
describe('native Agent trusted entry points', () => {
  it('keeps opt-in false, preserves explicit disable, and restores default independently of provider settings', async () => {
    expect(await invoke(AGENT_ADAPTER_IPC.settings)).toEqual({ enabled: false, customized: false });
    await invoke(AGENT_ADAPTER_IPC.configure, true);
    expect(await invoke(AGENT_ADAPTER_IPC.settings)).toEqual({ enabled: true, customized: true });
    await invoke(AGENT_ADAPTER_IPC.configure, false);
    expect(await invoke(AGENT_ADAPTER_IPC.settings)).toEqual({ enabled: false, customized: true });
    await invoke(AGENT_ADAPTER_IPC.configure, null);
    expect(await invoke(AGENT_ADAPTER_IPC.settings)).toEqual({ enabled: false, customized: false });
  });
  it('denies untrusted renderer and out-of-scope local resource calls', async () => {
    state.trusted = false;
    await expect(invoke(AGENT_ADAPTER_IPC.configure, true)).rejects.toThrow('PERMISSION_DENIED');
    expect(state.enabled).toBe(false);
    state.trusted = true;
    await expect(
      invoke(AGENT_ADAPTER_IPC.get, {
        client,
        ref: { ...agentResourceRef('catalog'), collectionId: 'teammates' },
      }),
    ).rejects.toThrow('INVALID_PARAMS');
    state.pending = true;
    await expect(invoke(AGENT_ADAPTER_IPC.settings)).rejects.toThrow('PRECONDITION_FAILED');
    await expect(invoke(AGENT_ADAPTER_IPC.configure, true)).rejects.toThrow('PRECONDITION_FAILED');
    expect(state.enabled).toBe(false);
  });
  it('requires stamped remote context and rejects revoked controllers even for reads', async () => {
    const request = { client, ref: agentResourceRef('catalog') },
      context = { controllerDeviceId: 'phone' };
    await expect(remoteResourceRegistry.get(context, request)).rejects.toThrow();
    state.context = { controllerDeviceId: 'phone', channel: REMOTE_RESOURCE_GET_CHANNEL };
    expect(await remoteResourceRegistry.get(context, request)).toMatchObject({
      ref: agentResourceRef('catalog'),
      actions: [],
    });
    state.revoked = ['phone'];
    await expect(remoteResourceRegistry.get(context, request)).rejects.toThrow();
    state.revoked = [];
    state.context.sharedTask = {};
    await expect(remoteResourceRegistry.get(context, request)).rejects.toThrow();
  });
  it('does not admit a directory grant returned after an owner switch', async () => {
    await invoke(AGENT_ADAPTER_IPC.configure, true);
    state.choose.mockImplementation(async () => {
      state.owner = 'owner:2';
      return { canceled: false, filePaths: ['/fake/project'] };
    });
    await expect(invoke(AGENT_ADAPTER_IPC.pickDirectory)).rejects.toThrow('PRECONDITION_FAILED');
    expect(state.choose).toHaveBeenCalledTimes(1);
  });
});
