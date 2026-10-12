import { useTranslation } from 'react-i18next';

import type { ProviderGroupMemberStatus } from '../../../shared/providerGroup';

/** 本机组设置与同账号组详情共用；分享能力不能覆盖主人自己的可用状态。 */
export function GroupMemberVersion({ status }: { status: ProviderGroupMemberStatus | undefined }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-12 leading-[1.5] text-[var(--text-tertiary)]">
      <span>{status?.appVersion
        ? t('providerGroup.member.version.current', { version: status.appVersion })
        : t('providerGroup.member.version.unknown')}</span>
      {status?.guestSupport === 'needs-update' && (
        <span className="text-[var(--warning-fg)]">{t('providerGroup.member.version.needsUpdate')}</span>
      )}
      {status && (!status.guestSupport || status.guestSupport === 'unknown') && (
        <span>{t('providerGroup.member.version.supportUnknown')}</span>
      )}
    </span>
  );
}
