import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function BotConnectionStatus({
  online = true,
  deviceName,
  inline = false,
  homeOffline = false,
  className,
}: {
  online?: boolean | null;
  /** The device is this companion's main computer (cloud companions): say so when offline. */
  homeOffline?: boolean;
  deviceName?: string;
  inline?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const offline = online === false;
  const status = offline ? t(homeOffline ? 'bots.cloud.homeOfflineShort' : 'bots.remote.offline') : '';
  const name = deviceName?.trim();
  const label = [status, name].filter(Boolean).join(' · ');
  if (inline) {
    if (!label) return null;
    return (
      <span title={label} className={cn('min-w-0 truncate text-11 leading-normal', className)}>
        {label}
      </span>
    );
  }
  if (!offline) return null;
  return (
    <span
      aria-hidden="true"
      title={label}
      className={cn(
        'absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-sidebar',
        'bg-[var(--remote-status-failed)]',
      )}
    />
  );
}
