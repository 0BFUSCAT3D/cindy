/**
 * useProviderAccountUsage —— API Key 供应商余额/额度数据 hook。
 *
 * 与订阅卡的 useProviderSubscriptionCard 互补：那边读 OAuth 订阅配额，这边经
 * PROVIDER_ACCOUNT_USAGE 读供应商自己的账户接口。挂载时拉一次；失败不轮询，重挂载
 * （重开详情/chip 重现）即重试。不支持（unsupported）时 supported=false，模块不渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ProviderView } from '@cindy/model-providers';

import type { ProviderAccountUsageResult } from '../../shared/providerAccountUsage';
import {
  hasDeepSeekOfficialRouteView,
  isZhipuCodingPlanProviderView,
} from '../lib/providerAccountUsageView';

export interface ProviderAccountUsageState {
  /** false = 该供应商没有可读的账户接口，调用方不应渲染模块。 */
  supported: boolean;
  result: ProviderAccountUsageResult | null;
  busy: boolean;
  refresh: () => void;
}

export function useProviderAccountUsage(
  provider: ProviderView | undefined,
): ProviderAccountUsageState {
  const supported =
    !!provider
    && provider.auth?.method !== 'oauth'
    && (hasDeepSeekOfficialRouteView(provider) || isZhipuCodingPlanProviderView(provider));
  const [result, setResult] = useState<ProviderAccountUsageResult | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (!provider?.id) return;
      const id = ++requestId.current;
      setBusy(true);
      try {
        const next = await window.electronAPI.maker.fetchProviderAccountUsage({
          providerId: provider.id,
          forceRefresh,
        });
        if (id === requestId.current) setResult(next);
      } catch {
        // IPC 层异常（不该发生）按未知失败处理，保留已有快照。
        if (id === requestId.current) setResult(null);
      } finally {
        if (id === requestId.current) setBusy(false);
      }
    },
    [provider?.id],
  );

  useEffect(() => {
    if (!supported) return;
    void load(false);
  }, [supported, provider?.id, load]);

  return {
    supported,
    result,
    busy,
    refresh: () => void load(true),
  };
}
