import { useEffect, useState } from 'react';
import {
  isSharedTaskPeer,
  parseProviderShareReceivedCatalogs,
  PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL,
  type ProviderShareReceived,
} from '@cindy/device-link';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * 分享授权属于账号，但跨区连接的启用标记在各电脑本地。新落点必须同时出现在被控端名单中。
 * 复用手机的只读查询，不恢复跨区连接、不修改授权；只消费名单，catalog 为 null 仍可保留。
 * 跟随已有的 received 推送刷新(包括后台轮询)，无需另起定时器。失败只收起新的分享落点，
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
    const invalidate = () => {
      revision += 1;
      pending = false;
      setSnapshot(null);
    };
    const refresh = async () => {
      if (!active || pending || !isDataOwnerGenerationCurrent(owner)) return;
      pending = true;
      const request = ++revision;
      const current = () => active && request === revision && isDataOwnerGenerationCurrent(owner);
      try {
        const value = await link.invoke(deviceId, PROVIDER_SHARE_RECEIVED_CATALOGS_CHANNEL, []);
        if (!current()) return;
        const ids = new Set(parseProviderShareReceivedCatalogs(value)
          .filter((share) => share.status === 'active')
          .map((share) => share.agentDeviceId));
        setSnapshot({ deviceId, owner, ids });
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
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [deviceId, owner, received]);

  return snapshot && snapshot.deviceId === deviceId && snapshot.owner === owner ? snapshot.ids : EMPTY_IDS;
}
