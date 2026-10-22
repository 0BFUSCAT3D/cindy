import { describe, expect, it } from 'vitest';

import { resolveUnifiedRoute, UnifiedRouteError, type UnifiedRouteCatalog } from './index.js';

/**
 * 测试价值
 * - 生产入口与可观察结果：调用公开的 resolveUnifiedRoute，验证任务最终选择的执行边界。
 * - Bug／规则依据：Agent Adapter 计划的旧路由兼容和凭证边界规则。
 * - 现有覆盖缺口：现有 provider-group/router 测试不覆盖外部 Agent 与旧 provider 的统一入口。
 * - 最小失败输入：默认请求、显式 Agent、显式 API、离线目标和跨节点工作目录。
 * - tier：unit；只使用内存目录，不启动进程、网络或真实账号。
 * - 实测耗时：单独运行本文件约 0.26 秒。
 */

const catalog: UnifiedRouteCatalog = {
  runtimeNodes: [
    { id: 'local', kind: 'local', status: 'online' },
    { id: 'remote-mac', kind: 'cindy-device', status: 'online' },
  ],
  agentInstances: [
    {
      id: 'opencode-local',
      adapterId: 'opencode',
      displayName: 'OpenCode（本机）',
      runtimeNodeId: 'local',
      status: 'ready',
      credentialBoundary: 'agent-owned',
      capabilities: ['streaming', 'workspace'],
    },
    {
      id: 'workbuddy-remote',
      adapterId: 'workbuddy',
      displayName: 'WorkBuddy（远程）',
      runtimeNodeId: 'remote-mac',
      status: 'ready',
      credentialBoundary: 'agent-owned',
      capabilities: ['streaming', 'workspace'],
    },
    {
      id: 'cursor-offline',
      adapterId: 'cursor',
      displayName: 'Cursor（离线）',
      runtimeNodeId: 'local',
      status: 'offline',
      credentialBoundary: 'agent-owned',
      capabilities: [],
    },
  ],
  officialApiAccounts: [
    {
      id: 'anthropic-api-main',
      adapterId: 'anthropic-api',
      providerId: 'anthropic',
      displayName: 'Anthropic API',
      status: 'ready',
      credentialBoundary: 'official-api',
      capabilities: ['messages'],
    },
  ],
  existingProviderRoutes: [
    {
      id: 'legacy-anthropic-local',
      providerId: 'anthropic',
      runtimeNodeId: 'local',
      status: 'ready',
      credentialBoundary: 'existing-provider',
    },
  ],
  defaultExistingProviderRouteId: 'legacy-anthropic-local',
};

describe('resolveUnifiedRoute', () => {
  it('keeps an omitted target on the existing provider route', () => {
    expect(resolveUnifiedRoute({ sessionId: 'legacy-session' }, catalog)).toEqual({
      kind: 'existing-provider',
      routeId: 'legacy-anthropic-local',
      providerId: 'anthropic',
      runtimeNodeId: 'local',
      credentialBoundary: 'existing-provider',
    });
  });

  it('resolves an explicit Agent instance and matching workspace', () => {
    expect(resolveUnifiedRoute({
      sessionId: 'agent-session',
      target: { kind: 'agent-native', agentInstanceId: 'workbuddy-remote' },
      workspace: { id: 'remote-project', runtimeNodeId: 'remote-mac', root: '/workspace/project' },
    }, catalog)).toEqual({
      kind: 'agent-native',
      adapterId: 'workbuddy',
      agentInstanceId: 'workbuddy-remote',
      runtimeNodeId: 'remote-mac',
      workspace: { id: 'remote-project', runtimeNodeId: 'remote-mac', root: '/workspace/project' },
      credentialBoundary: 'agent-owned',
    });
  });

  it('resolves an official API account separately from an Agent subscription', () => {
    expect(resolveUnifiedRoute({
      sessionId: 'api-session',
      target: { kind: 'official-api', accountId: 'anthropic-api-main' },
    }, catalog)).toMatchObject({
      kind: 'official-api',
      accountId: 'anthropic-api-main',
      providerId: 'anthropic',
      credentialBoundary: 'official-api',
    });
  });

  it('fails explicitly instead of falling back when an Agent is unavailable', () => {
    expect(() => resolveUnifiedRoute({
      sessionId: 'offline-session',
      target: { kind: 'agent-native', agentInstanceId: 'cursor-offline' },
    }, catalog)).toThrowError(new UnifiedRouteError('target-unavailable', 'Route target is not ready: cursor-offline'));
  });

  it('rejects a workspace that belongs to another runtime node', () => {
    expect(() => resolveUnifiedRoute({
      sessionId: 'mismatch-session',
      target: { kind: 'agent-native', agentInstanceId: 'opencode-local' },
      workspace: { id: 'wrong-project', runtimeNodeId: 'remote-mac', root: '/workspace/project' },
    }, catalog)).toThrowError(/Workspace wrong-project belongs to runtime node remote-mac/);
  });

  it('never treats a non-agent-owned boundary as an Agent subscription', () => {
    const unsafe: UnifiedRouteCatalog = {
      ...catalog,
      agentInstances: catalog.agentInstances.map((instance, index) =>
        index === 0 ? { ...instance, credentialBoundary: 'official-api' } as never : instance,
      ),
    };
    expect(() => resolveUnifiedRoute({
      sessionId: 'boundary-session',
      target: { kind: 'agent-native', agentInstanceId: 'opencode-local' },
    }, unsafe)).toThrowError(/does not keep credentials in the Agent runtime/);
  });
});
