import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import { setBotSchedulerBotId, useBotAutonomySettings } from './botStore';

/** A local invitation after a user sends a message; showing it never runs a model or reads tasks. */
export function BotFollowUpInvitation({ botId, engaged }: { botId: string; engaged: boolean }) {
  const { t } = useTranslation();
  const settings = useBotAutonomySettings();
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  if (!engaged || !settings || settings.isCustomized || settings.schedulerBotId !== null) return null;

  const choose = async (enable: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    const owner = getDataOwnerGeneration();
    try {
      // null is an explicit choice too: do not ask again after "Not now".
      await setBotSchedulerBotId(enable ? botId : null);
    } catch {
      if (isDataOwnerGenerationCurrent(owner)) toast.error(t('bots.autonomy.saveFailed'));
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <BotFollowUpInvitationCard pending={pending} onChoose={choose} />;
}

export function BotFollowUpInvitationCard({ pending, onChoose, consent }: {
  pending: boolean; onChoose(enable: boolean): void | Promise<void>; consent?: string;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  // 卡片只占一行；读什么、会用模型额度在开启前的确认框里完整说明（与设置页同一确认），确认后才保存。
  const scope = consent ?? t('bots.autonomy.consent');
  const start = async () => {
    const accepted = await confirm({
      presentation: 'standard',
      title: t('bots.autonomy.invitation.title'),
      description: scope,
      confirmText: t('bots.autonomy.invitation.start'),
      cancelText: t('bots.autonomy.invitation.notNow'),
    });
    if (accepted) await onChoose(true);
  };
  return (
    <section
      className="flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 rounded-xl border border-[var(--border-default)] py-1.5 pl-3 pr-1.5"
      aria-label={t('bots.autonomy.invitation.title')}
    >
      <p className="min-w-[8rem] flex-1 text-13 leading-5 text-[var(--text-primary)]">{t('bots.autonomy.invitation.title')}</p>
      <Button variant="cta" size="sm" disabled={pending} onClick={() => void start()}>{t('bots.autonomy.invitation.start')}</Button>
      <Button variant="secondary" tone="quiet" size="sm" disabled={pending} onClick={() => void onChoose(false)}>{t('bots.autonomy.invitation.notNow')}</Button>
    </section>
  );
}
