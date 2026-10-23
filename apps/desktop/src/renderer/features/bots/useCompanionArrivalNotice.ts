import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { companionCloudApi, refreshCompanionCloud, useCompanionCloud } from './companionCloudStore';

/**
 * The notices shown per bot in this window, so a snapshot still carrying them (before main's
 * dismissal is read back) never repeats the toast. An empty snapshot forgets them: the next arrival
 * of the same companion is a new one and shows again.
 */
const shown = new Map<string, string>();

/**
 * One line after a companion arrived on this computer for what its old setup could not keep (the
 * permission level never travels; a saved model that is not usable here is replaced by this
 * computer's default). Shown when its chat opens, then dismissed in main
 * (docs/product-rules/cloud-companions.md §2).
 */
export function useCompanionArrivalNotice(botId: string | undefined, name: string | undefined): void {
  const { t } = useTranslation();
  const notices = useCompanionCloud().actors.find((actor) => actor.externalId === botId)?.arrivalNotices;
  useEffect(() => {
    if (!botId) return;
    if (!notices?.length) {
      shown.delete(botId);
      return;
    }
    const batch = notices.join(',');
    if (shown.get(botId) === batch) return;
    shown.set(botId, batch);
    for (const notice of notices) {
      toast.info(t(notice === 'model' ? 'bots.cloud.arrivalModel' : 'bots.cloud.arrivalPermissions', { name: name ?? '' }));
    }
    void companionCloudApi()?.dismissCompanionArrivalNotices?.(botId).then(refreshCompanionCloud, () => undefined);
  }, [botId, name, notices, t]);
}
