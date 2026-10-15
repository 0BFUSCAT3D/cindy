import { useEffect, useState } from 'react';
import {
  isSharedTaskPeer,
  parseProviderShareReceivedCatalogs,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
  type ProviderShareReceived,
} from '@cindy/device-link';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const EMPTY_IDS: ReadonlySet<string> = new Set();
const RECEIVED_LIST_RETRY_BASE_MS = 250;
const RECEIVED_LIST_RETRY_MAX_MS = 30_000;

/**
 * 分享授权属于账号，但跨区连接的启用标记在各电脑本地。新落点必须同时出现在被控端名单中。
 * 复用手机的只读查询，不恢复跨区连接、不修改授权；只消费名单，catalog 为 null 仍可保留。
 * 就绪后跟随已有的 received 推送刷新(包括后台轮询)；首次未就绪时按有上限的指数退避重查。
 * 失败只收起新的分享落点，
 * 不重连 peer/relay，也不影响普通设备或本机供应商。
 */
export function useControlledShareIds(
  deviceId: string | null | undefined,
  received: readonly ProviderShareReceived[],
): ReadonlySet<string> {
  const owner = getDataOwnerGeneration();
  const [snapshot, setSnapshot] = useState<{
    deviceId: string;
    owner: typeof owner;
    ids: ReadonlySet<string>;
  } | null>(null);

  useEffect(() => {
    if (!deviceId || isSharedTaskPeer(deviceId) || received.length === 0) return;
    const link = window.electronAPI?.deviceLink;
    if (!link) return;
    let active = true;
    let revision = 0;
    let pending = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let readinessRetryAttempt = 0;
    const invalidate = () => {
      revision += 1;
      pending = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      readinessRetryAttempt = 0;
      setSnapshot(null);
    };
    const scheduleReadinessRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      const delay = Math.min(
        RECEIVED_LIST_RETRY_MAX_MS,
        RECEIVED_LIST_RETRY_BASE_MS * 2 ** Math.min(readinessRetryAttempt, 7),
      );
      readinessRetryAttempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      if (!active || pending || !isDataOwnerGenerationCurrent(owner)) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      pending = true;
      const request = ++revision;
      const current = () => active && request === revision && isDataOwnerGenerationCurrent(owner);
      try {
        // 这里只需确认被控端已加载哪些分享；不要让模型目录读取(每个分享
        // 可能等待远端供应商响应数秒)阻塞候选发现。需要目录的页面仍使用
        // `maker:provider:list` 的既有读取路径。
        const value = await link.invoke(deviceId, PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, [
          { includeCatalog: false },
        ]);
        if (!current()) return;
        // ready 只表示各区域名单是否完整；已返回的分享仍可立即使用。
        // 暂态空列表继续重查，不能因另一区域未就绪而丢弃已加载区域的分享。
        const ids = new Set(parseProviderShareReceivedCatalogs(value)
          .filter((share) => share.status === 'active')
          .map((share) => share.agentDeviceId));
        setSnapshot({ deviceId, owner, ids });
        const ready = !(value && typeof value === 'object' && !Array.isArray(value)
          && (value as { ready?: unknown }).ready === false);
        if (!ready) {
          scheduleReadinessRetry();
          return;
        }
        readinessRetryAttempt = 0;
      } catch {
        // 旧主机、断链和读失败都不把控制端名单当成被控端可用性的证据。
        if (current()) setSnapshot(null);
      } finally {
        if (current()) pending = false;
      }
    };
    const onFocus = () => { void refresh(); };
    const unsubscribe = link.onStatusChanged?.(({ status }) => {
      invalidate();
      if (status === 'online') void refresh();
    });
    window.addEventListener('focus', onFocus);
    void refresh();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [deviceId, owner, received]);

  return snapshot && snapshot.deviceId === deviceId && snapshot.owner === owner ? snapshot.ids : EMPTY_IDS;
}
