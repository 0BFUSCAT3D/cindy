import { describe, expect, it, vi } from 'vitest';

import { createAgentAdapterRuntime } from '../runtime.js';
import { RuntimeNodeDirectory } from '../runtime-node-directory.js';
import {
  createDesktopRuntimeNodeSource,
  projectRuntimeNodes,
  type RuntimeNodeSourceSnapshot,
} from '../runtime-node-sources.js';
import type { RuntimeNodeRef } from '@cindy/maker-core/agent-adapters';

/**
 * 测试价值
 * - 生产入口与可观察结果：通过 Desktop main 的 runtime/registry 入口验证 rollout gate、节点目录和发现结果。
 * - Bug／规则依据：P1 默认关闭、Agent 适配器凭证边界和节点绑定规则。
 * - 现有覆盖缺口：旧 provider route 测试不覆盖新 main 注册表的关闭行为。
 * - 最小失败输入：关闭注册表、离线节点、跨节点发现结果和节点移除后的目录投影。
 * - tier：unit；不启动 Electron、Agent、网络或真实账号。
 * - 实测耗时：单独运行本文件应低于 5 秒。
 */

describe('AgentAdapterRuntime', () => {
  it('keeps the P1 registry disabled by default and does not call adapters', async () => {
    const discover = vi.fn(async () => []);
    const runtime = createAgentAdapterRuntime();
    runtime.registry.registerAgentAdapter({
      id: 'fake-agent',
      kind: 'agent-native',
      discover,
      start: vi.fn(),
    });

    const result = await runtime.discover();

    expect(runtime.enabled).toBe(false);
    expect(result).toEqual({ agentInstances: [], officialApiAccounts: [], failures: [] });
    expect(discover).not.toHaveBeenCalled();
  });

  it('projects non-secret adapter metadata and disabled status without discovery', () => {
    const runtime = createAgentAdapterRuntime();
    runtime.registry.registerAgentAdapter({
      id: 'opencode',
      kind: 'agent-native',
      metadata: {
        id: 'opencode',
        kind: 'agent-native',
        displayName: 'OpenCode',
        credentialBoundary: 'agent-owned',
        capabilities: ['workspace', 'streaming', 'workspace'],
      },
      discover: vi.fn(async () => []),
      start: vi.fn(),
    });

    expect(runtime.listAdapterMetadata()).toEqual([
      {
        id: 'opencode',
        kind: 'agent-native',
        displayName: 'OpenCode',
        credentialBoundary: 'agent-owned',
        capabilities: ['workspace', 'streaming'],
      },
    ]);
    expect(runtime.listAdapterStatuses()).toEqual([
      {
        metadata: {
          id: 'opencode',
          kind: 'agent-native',
          displayName: 'OpenCode',
          credentialBoundary: 'agent-owned',
          capabilities: ['workspace', 'streaming'],
        },
        status: 'disabled',
        runtimeNodeIds: [],
        discoveredInstanceIds: [],
        discoveredAccountIds: [],
        failureCount: 0,
      },
    ]);
  });

  it('does not read runtime-node sources while the disabled registry is idle', async () => {
    const readSource = vi.fn(() => ({
      sshHosts: [{ hostId: 'must-not-be-read', status: 'ready' as const }],
    }));
    const runtime = createAgentAdapterRuntime({ runtimeNodeSource: readSource });

    expect(runtime.nodes.list()).toEqual([{ id: 'local', kind: 'local', status: 'online' }]);
    await runtime.discover();
    expect(readSource).not.toHaveBeenCalled();
  });

  it('does not read runtime-node sources during an explicit refresh while disabled', () => {
    const readSource = vi.fn(() => ({
      sshHosts: [{ hostId: 'must-not-be-read', status: 'ready' as const }],
    }));
    const runtime = createAgentAdapterRuntime({ runtimeNodeSource: readSource });

    expect(runtime.refreshRuntimeNodes()).toEqual([
      { id: 'local', kind: 'local', status: 'online' },
    ]);
    expect(readSource).not.toHaveBeenCalled();
  });

  it('follows an enabled live node source and unsubscribes on dispose', () => {
    let sourceNodes: RuntimeNodeSourceSnapshot = {
      local: { id: 'local', kind: 'local', status: 'online' },
    };
    let onChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((listener: () => void) => {
      onChanged = listener;
      return unsubscribe;
    });
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      runtimeNodeSource: () => sourceNodes,
      runtimeNodeSourceSubscribe: subscribe,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    sourceNodes = {
      local: { id: 'local', kind: 'local', status: 'online' },
      deviceLinks: [{ deviceId: 'peer', platform: 'darwin', online: true }],
    };
    onChanged?.();
    expect(runtime.nodes.list()).toEqual([
      { id: 'local', kind: 'local', status: 'online' },
      { id: 'device:peer', kind: 'cindy-device', status: 'online', label: 'peer' },
    ]);

    runtime.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    sourceNodes = { local: { id: 'local', kind: 'local', status: 'offline' } };
    onChanged?.();
    expect(runtime.nodes.list()).toEqual([
      { id: 'local', kind: 'local', status: 'online' },
      { id: 'device:peer', kind: 'cindy-device', status: 'online', label: 'peer' },
    ]);
  });

  it('does not subscribe to a live node source while disabled', () => {
    const subscribe = vi.fn(() => vi.fn());
    const runtime = createAgentAdapterRuntime({
      runtimeNodeSource: () => ({ sshHosts: [{ hostId: 'must-not-be-read', status: 'ready' }] }),
      runtimeNodeSourceSubscribe: subscribe,
    });

    expect(subscribe).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it('keeps legacy catalog resolution source-free while the registry is disabled', () => {
    const readSource = vi.fn(() => ({
      sshHosts: [{ hostId: 'must-not-be-read', status: 'ready' as const }],
    }));
    const runtime = createAgentAdapterRuntime({
      runtimeNodeSource: readSource,
      existingProviderRoutes: [
        {
          id: 'legacy-route',
          providerId: 'anthropic',
          status: 'ready',
          credentialBoundary: 'existing-provider',
        },
      ],
      defaultExistingProviderRouteId: 'legacy-route',
    });

    expect(runtime.resolve({ sessionId: 'legacy-session' })).toMatchObject({
      kind: 'existing-provider',
      routeId: 'legacy-route',
    });
    expect(readSource).not.toHaveBeenCalled();
  });

  it('discovers only on online nodes when explicitly enabled', async () => {
    const discover = vi.fn(async (node) => [
      {
        id: `fake-${node.id}`,
        adapterId: 'fake-agent',
        displayName: node.id,
        runtimeNodeId: node.id,
        status: 'ready' as const,
        credentialBoundary: 'agent-owned' as const,
        capabilities: [],
      },
    ]);
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      runtimeNodes: [
        { id: 'local', kind: 'local', status: 'online' },
        { id: 'offline', kind: 'cindy-device', status: 'offline' },
      ],
    });
    runtime.registry.registerAgentAdapter({
      id: 'fake-agent',
      kind: 'agent-native',
      discover,
      start: vi.fn(),
    });

    const result = await runtime.discover();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(result.agentInstances).toHaveLength(1);
    expect(result.agentInstances[0]?.runtimeNodeId).toBe('local');
  });

  it('does not expose discovered instances after their runtime node is removed', async () => {
    const runtime = createAgentAdapterRuntime({ enabled: true });
    runtime.registry.registerAgentAdapter({
      id: 'fake-agent',
      kind: 'agent-native',
      discover: async (node) => [
        {
          id: 'fake-local',
          adapterId: 'fake-agent',
          displayName: 'Fake local',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: [],
        },
      ],
      start: vi.fn(),
    });

    await runtime.discover();
    expect(runtime.catalog().agentInstances).toHaveLength(1);
    expect(runtime.listAdapterStatuses()[0]?.discoveredInstanceIds).toEqual(['fake-local']);

    runtime.nodes.remove('local');

    expect(runtime.catalog().agentInstances).toEqual([]);
    expect(runtime.listAdapterStatuses()[0]?.discoveredInstanceIds).toEqual([]);
  });

  it('records a discovery failure without changing the legacy route catalog', async () => {
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      existingProviderRoutes: [
        {
          id: 'legacy-anthropic',
          providerId: 'anthropic',
          status: 'ready',
          credentialBoundary: 'existing-provider',
        },
      ],
      defaultExistingProviderRouteId: 'legacy-anthropic',
    });
    runtime.registry.registerAgentAdapter({
      id: 'broken-agent',
      kind: 'agent-native',
      discover: async () => {
        throw new Error('unavailable');
      },
      start: vi.fn(),
    });

    const result = await runtime.discover();

    expect(result.failures).toHaveLength(1);
    expect(runtime.catalog().defaultExistingProviderRouteId).toBe('legacy-anthropic');
    expect(runtime.resolve({ sessionId: 'legacy-session' })).toMatchObject({
      kind: 'existing-provider',
      routeId: 'legacy-anthropic',
    });
    expect(runtime.listAdapterStatuses()).toMatchObject([
      {
        status: 'degraded',
        runtimeNodeIds: ['local'],
        failureCount: 1,
      },
    ]);
  });

  it('does not retain adapter-owned fields or raw discovery errors in projections', async () => {
    const runtime = createAgentAdapterRuntime({ enabled: true });
    runtime.registry.registerAgentAdapter({
      id: 'unsafe-agent',
      kind: 'agent-native',
      discover: async (node) => [
        {
          id: 'unsafe-local',
          adapterId: 'unsafe-agent',
          displayName: 'Unsafe local',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: [],
          token: 'must-not-escape',
        } as never,
      ],
      start: vi.fn(),
    });

    const result = await runtime.discover();

    expect(result.agentInstances[0]).not.toHaveProperty('token');

    const broken = createAgentAdapterRuntime({ enabled: true });
    broken.registry.registerAgentAdapter({
      id: 'broken-agent',
      kind: 'agent-native',
      discover: async () => {
        throw new Error('token=must-not-escape');
      },
      start: vi.fn(),
    });
    const failure = await broken.discover();
    expect(failure.failures[0]).toEqual({
      adapterId: 'broken-agent',
      runtimeNodeId: 'local',
      message: 'Adapter discovery failed',
    });
  });

  it('fails closed when discovery crosses a credential boundary or returns duplicate ids', async () => {
    const wrongBoundary = createAgentAdapterRuntime({ enabled: true });
    wrongBoundary.registry.registerAgentAdapter({
      id: 'boundary-agent',
      kind: 'agent-native',
      discover: async (node) => [
        {
          id: 'boundary-instance',
          adapterId: 'boundary-agent',
          displayName: 'Boundary instance',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'official-api',
          capabilities: [],
        } as never,
      ],
      start: vi.fn(),
    });

    const boundaryResult = await wrongBoundary.discover();
    expect(boundaryResult.agentInstances).toEqual([]);
    expect(boundaryResult.failures).toEqual([
      {
        adapterId: 'boundary-agent',
        runtimeNodeId: 'local',
        message: 'Adapter discovery failed',
      },
    ]);

    const duplicate = createAgentAdapterRuntime({ enabled: true });
    duplicate.registry.registerAgentAdapter({
      id: 'duplicate-agent',
      kind: 'agent-native',
      discover: async (node) => [
        {
          id: 'same-instance',
          adapterId: 'duplicate-agent',
          displayName: 'First',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: [],
        },
        {
          id: 'same-instance',
          adapterId: 'duplicate-agent',
          displayName: 'Second',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: [],
        },
      ],
      start: vi.fn(),
    });

    const duplicateResult = await duplicate.discover();
    expect(duplicateResult.agentInstances).toEqual([]);
    expect(duplicateResult.failures).toHaveLength(1);
    expect(duplicate.listAdapterStatuses()[0]).toMatchObject({
      status: 'degraded',
      failureCount: 1,
      discoveredInstanceIds: [],
    });

    const wrongApiBoundary = createAgentAdapterRuntime({ enabled: true });
    wrongApiBoundary.registry.registerProviderAdapter({
      id: 'official-api',
      kind: 'official-api',
      discover: async (node) => [
        {
          id: 'api-account',
          adapterId: 'official-api',
          providerId: 'example',
          displayName: 'Example API',
          runtimeNodeId: node.id,
          status: 'ready',
          credentialBoundary: 'agent-owned',
          capabilities: [],
        } as never,
      ],
    });

    const apiBoundaryResult = await wrongApiBoundary.discover();
    expect(apiBoundaryResult.officialApiAccounts).toEqual([]);
    expect(apiBoundaryResult.failures).toEqual([
      {
        adapterId: 'official-api',
        runtimeNodeId: 'local',
        message: 'Adapter discovery failed',
      },
    ]);
  });

  it('does not reserve ids from a rejected batch for a later runtime node', async () => {
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      runtimeNodes: [
        { id: 'first', kind: 'local', status: 'online' },
        { id: 'second', kind: 'cindy-device', status: 'online' },
      ],
    });
    runtime.registry.registerAgentAdapter({
      id: 'batch-agent',
      kind: 'agent-native',
      discover: async (node) =>
        node.id === 'first'
          ? [
              {
                id: 'shared-instance',
                adapterId: 'batch-agent',
                displayName: 'First valid item',
                runtimeNodeId: node.id,
                status: 'ready',
                credentialBoundary: 'agent-owned',
                capabilities: [],
              },
              {
                id: 'shared-instance',
                adapterId: 'batch-agent',
                displayName: 'Duplicate item',
                runtimeNodeId: node.id,
                status: 'ready',
                credentialBoundary: 'agent-owned',
                capabilities: [],
              },
            ]
          : [
              {
                id: 'shared-instance',
                adapterId: 'batch-agent',
                displayName: 'Second node instance',
                runtimeNodeId: node.id,
                status: 'ready',
                credentialBoundary: 'agent-owned',
                capabilities: [],
              },
            ],
      start: vi.fn(),
    });

    const result = await runtime.discover();

    expect(result.failures).toEqual([
      {
        adapterId: 'batch-agent',
        runtimeNodeId: 'first',
        message: 'Adapter discovery failed',
      },
    ]);
    expect(result.agentInstances).toEqual([
      expect.objectContaining({
        id: 'shared-instance',
        runtimeNodeId: 'second',
        displayName: 'Second node instance',
      }),
    ]);
  });

  it('projects local, desktop Device Link, and SSH nodes while filtering mobile peers', () => {
    expect(
      projectRuntimeNodes({
        deviceLinks: [
          {
            deviceId: 'mac-peer',
            label: 'Mac peer',
            platform: 'darwin',
            online: true,
            available: false,
          },
          { deviceId: 'phone-peer', label: 'Phone', platform: 'ios', online: true },
          { deviceId: 'offline-win', platform: 'win32', online: false },
        ],
        sshHosts: [
          { hostId: 'ready-host', label: 'Ready host', status: 'ready' },
          { hostId: 'connecting-host', status: 'connecting' },
          { hostId: 'failed-host', status: 'failed' },
        ],
      }),
    ).toEqual([
      { id: 'local', kind: 'local', status: 'online' },
      { id: 'device:mac-peer', kind: 'cindy-device', status: 'degraded', label: 'Mac peer' },
      { id: 'device:offline-win', kind: 'cindy-device', status: 'offline', label: 'offline-win' },
      { id: 'ssh:ready-host', kind: 'ssh', status: 'online', label: 'Ready host' },
      { id: 'ssh:connecting-host', kind: 'ssh', status: 'degraded', label: 'connecting-host' },
      { id: 'ssh:failed-host', kind: 'ssh', status: 'offline', label: 'failed-host' },
    ]);
  });

  it('uses the injected live local host state instead of forcing local online', () => {
    let local: RuntimeNodeRef = {
      id: 'local',
      kind: 'local',
      status: 'offline',
      label: 'MacBook Air',
    };
    const source = createDesktopRuntimeNodeSource({
      getLocalNode: () => local,
      getDeviceLinks: () => [],
      getSshHosts: () => [],
    });

    expect(projectRuntimeNodes(source())).toEqual([local]);
    local = { ...local, status: 'degraded' };
    expect(projectRuntimeNodes(source())).toEqual([local]);
    local = { ...local, status: 'online' };
    expect(projectRuntimeNodes(source())).toEqual([local]);
  });

  it('refreshes source nodes atomically and removes nodes that disappear', async () => {
    let sourceNodes: RuntimeNodeSourceSnapshot[] = [
      {
        local: { id: 'local', kind: 'local' as const, status: 'online' as const },
        sshHosts: [{ hostId: 'first', status: 'ready' as const }],
      },
    ];
    const runtime = createAgentAdapterRuntime({
      enabled: true,
      runtimeNodeSource: () => sourceNodes[0]!,
    });

    expect(runtime.nodes.list().map((node) => node.id)).toEqual(['local']);
    expect(runtime.refreshRuntimeNodes().map((node) => node.id)).toEqual(['local', 'ssh:first']);
    sourceNodes = [
      {
        local: { id: 'local', kind: 'local' as const, status: 'online' as const },
        sshHosts: [{ hostId: 'second', status: 'reconnecting' as const }],
      },
    ];
    expect(runtime.refreshRuntimeNodes()).toEqual([
      { id: 'local', kind: 'local', status: 'online' },
      { id: 'ssh:second', kind: 'ssh', status: 'degraded', label: 'second' },
    ]);

    const before = runtime.nodes.list();
    sourceNodes = [
      {
        local: { id: 'local', kind: 'local' as const, status: 'online' as const },
        sshHosts: [
          { hostId: 'bad/id', status: 'ready' as const },
          { hostId: 'bad/id', status: 'failed' as const },
        ],
      },
    ];
    expect(() => runtime.refreshRuntimeNodes()).toThrow(
      'Runtime node is already registered: ssh:bad/id',
    );
    expect(runtime.nodes.list()).toEqual(before);
  });

  it('keeps the directory snapshot isolated from caller mutations', () => {
    const directory = new RuntimeNodeDirectory([
      { id: 'local', kind: 'local', status: 'online', label: 'before' },
    ]);
    const listed = directory.list();
    listed[0]!.label = 'mutated';
    expect(directory.get('local')).toEqual({
      id: 'local',
      kind: 'local',
      status: 'online',
      label: 'before',
    });
  });
});
