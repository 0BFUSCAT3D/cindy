// @vitest-environment jsdom
/**
 * Orca Lead 回落切回本机：已归本机供应商组时，点本机同引擎行不得把选择改写成离线组员。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      const o = options ?? {};
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': '模型列表',
        'newChat.modelSelector.search.placeholderAll': '搜索模型…',
        'newChat.modelSelector.unified.favoritesGroup': '收藏',
        'newChat.modelSelector.unified.customize': '自定义',
        'newChat.modelSelector.unified.railAll': '全部',
        'newChat.modelSelector.unified.railRemoteProvider': `${o.provider} · ${o.device}`,
        'newChat.modelSelector.unified.providerGroupLabel': `${o.provider} · ${o.group}`,
        'settings.providers.remote.groupBadge': `供应商组 · ${o.count} 台电脑`,
        'effortLevels.low': '低',
        'effortLevels.high': '高',
      };
      return table[key] ?? (o.defaultValue as string | undefined) ?? key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: false, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

const catalogs = vi.hoisted(() => {
  const models = [
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
  ] as const;
  const provider = (id: string, name: string) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'api-key' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': models.map(([modelId, modelName]) => ({
        id: modelId,
        name: modelName,
        contextWindow: 200000,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      })),
    },
  });
  return {
    local: [provider('anthropic', 'Anthropic')] as unknown[],
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({
    providers: [],
    loading: false,
    error: 'DEVICE_LINK_TIMEOUT',
    unsupported: false,
  }),
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: () => new Map(),
}));
vi.mock('@/features/provider-group/useLocalProviderGroups', () => ({
  useLocalProviderGroups: () => ({
    anthropic: {
      strategy: 'least',
      autoSwitch: true,
      members: [
        { key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', paused: false },
        { key: 'device:office:anthropic-office', kind: 'device', agentDeviceId: 'office-pc', providerId: 'anthropic-office', paused: false },
      ],
    },
  }),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

function row(name: string): HTMLElement {
  return within(screen.getByRole('listbox')).getByText(name).closest('[role="option"]') as HTMLElement;
}

beforeEach(() => {
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('Orca Lead 回落切回本机：本机供应商组不得改写落点', () => {
  it('点本机同引擎行时 onRelocate 收到 agentDevice null 与该行本机来源', async () => {
    const onRelocate = vi.fn(async () => true);
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'cloud-opus',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'anthropic-office',
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        remoteAgent: {
          devices: [],
          selectedDeviceId: 'office-pc',
          readProviderGroup: async () => ({ deviceId: null, providerId: 'anthropic' }),
          onRelocate,
        },
      }),
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(row('Sonnet'));
    });
    expect(onRelocate).toHaveBeenCalledTimes(1);
    expect(onRelocate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        modelId: 'sonnet',
        agent: 'claude-code',
        agentDevice: null,
      }),
    );
  });
});
