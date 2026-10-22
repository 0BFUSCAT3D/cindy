import { createContext, useContext, useEffect, useState } from 'react';
import type { ProviderShareReceived } from '@cindy/device-link';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  weeklyQuota,
  type ProviderWeeklyQuota,
} from '@/components/new-chat/useProviderWeeklyQuota';
import { providerShareIdOfAgentDeviceId } from '../../../shared/providerShare';
import type { ProviderShareInsights } from '../../../shared/providerShareInsights';
import { useProviderShareReceived } from './providerShareStore';

// Popovers may retain their children during the closing animation. Stop reads at close,
// while directly mounted model lists remain eligible for viewing.
export const ProviderShareQuotaViewingContext = createContext(true);

function shareIdentity(share: ProviderShareReceived | undefined): string {
  return share
    ? JSON.stringify([
        share.shareId,
        share.memberId,
        share.status,
        share.hostOnline,
        share.hostCapable,
      ])
    : '';
}

function readWeeklyQuota(view: ProviderShareInsights): ProviderWeeklyQuota | null {
  if (
    !view.capabilities.quota ||
    view.status.quota !== 'ready' ||
    view.quota?.group !== false ||
    view.quota.accounts.length !== 1
  )
    return null;
  const account = view.quota.accounts[0];
  if (account.state !== 'ready' || account.balance) return null;
  const window = account.windows.find(
    (item) => item.kind === 'week' || item.windowMinutes === 10_080,
  );
  return window
    ? weeklyQuota(
        100 - window.remainingPercent,
        window.resetsAt === null ? null : window.resetsAt / 1000,
        Date.now(),
      )
    : null;
}

/** Mounted rail only: read permission + quota, never request or retain usage history. */
export function useProviderShareWeeklyQuota(deviceId: string): ProviderWeeklyQuota | null {
  useOptionalAuthUser();
  const viewing = useContext(ProviderShareQuotaViewingContext);
  const owner = getDataOwnerGeneration();
  const { received } = useProviderShareReceived();
  const shareId = providerShareIdOfAgentDeviceId(deviceId);
  const share = received.find((item) => item.shareId === shareId);
  const identity = shareIdentity(share);
  const available = share?.status === 'active' && share.hostOnline && share.hostCapable;
  const [result, setResult] = useState<{
    identity: string;
    owner: typeof owner;
    quota: ProviderWeeklyQuota | null;
  } | null>(null);

  useEffect(() => {
    setResult(null);
    if (!viewing || !available || !shareId) return;
    let alive = true;
    let valid = true;
    let reading = false;
    let generation = 0;
    let lastRead = -Infinity;
    const clear = () => {
      generation++;
      setResult(null);
    };
    const load = async () => {
      if (!isDataOwnerGenerationCurrent(owner)) {
        clear();
        return;
      }
      if (
        !alive ||
        !valid ||
        reading ||
        document.visibilityState === 'hidden' ||
        Date.now() - lastRead < 5_000
      )
        return;
      reading = true;
      lastRead = Date.now();
      const request = generation;
      try {
        const view = await window.electronAPI.providerShare.command({
          action: 'insights',
          shareId,
          includeUsage: false,
        });
        if (alive && request === generation && isDataOwnerGenerationCurrent(owner)) {
          setResult({ identity, owner, quota: readWeeklyQuota(view) });
        }
      } catch {
        if (alive && request === generation) setResult(null);
      } finally {
        reading = false;
      }
    };
    const off = window.electronAPI.providerShare.onReceivedChanged((shares) => {
      const next = shareIdentity(shares.find((item) => item.shareId === shareId));
      if (next !== identity) {
        valid = false;
        clear();
      } else if (!valid) {
        valid = true;
        void load();
      }
    });
    const visibility = () => {
      clear();
      if (document.visibilityState !== 'hidden') void load();
    };
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => void load(), 5_000);
    void load();
    return () => {
      alive = false;
      generation++;
      off();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [available, identity, owner, shareId, viewing]);

  return viewing &&
    available &&
    result?.identity === identity &&
    isDataOwnerGenerationCurrent(result.owner) &&
    document.visibilityState !== 'hidden' &&
    result.quota
    ? weeklyQuota(result.quota.usedPercent, result.quota.resetsAt, Date.now())
    : null;
}
