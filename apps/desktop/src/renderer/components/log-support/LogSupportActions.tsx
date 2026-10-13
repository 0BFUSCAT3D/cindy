import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLogUploadSettings } from '@/hooks/useLogUploadSettings';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';

interface LogSupportRowProps {
  presentation?: 'settings' | 'dialog';
}

// Shared by Settings and the startup/login recovery surface. Neither action needs a login.
export function OpenLogsRow({ presentation = 'settings' }: LogSupportRowProps) {
  const { t } = useTranslation();
  const inDialog = presentation === 'dialog';
  const handleOpen = async () => {
    try {
      const res = await window.electronAPI.openLogsDir();
      if (!res.success) toast.error(t('settings.about.openLogsDirError'));
    } catch {
      toast.error(t('settings.about.openLogsDirError'));
    }
  };

  return (
    // Preserve AboutSection's existing 18px row gutter; dialogs supply their own panel padding.
    <div
      className={cn(
        'flex justify-between gap-3',
        inDialog ? 'items-start' : 'items-center px-[18px] py-4',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span
          id={inDialog ? undefined : 'settings-search-settings-about-logsDirLabel'}
          className={cn(
            'text-13',
            inDialog ? 'text-[var(--confirm-title)]' : 'text-[var(--settings-section-sublabel)]',
          )}
        >
          {t('settings.about.logsDirLabel')}
        </span>
        {inDialog && (
          <p className="text-12 leading-normal text-[var(--confirm-desc)]">
            {t('logSupport.localFiles')}
          </p>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={handleOpen}
        palette={inDialog ? 'confirmation' : 'default'}
        className={inDialog ? 'px-3' : '-mr-1 px-2.5'}
        title={t('settings.about.openLogsDirTooltip')}
      >
        {!inDialog && <FolderOpen size={13} />}
        {t('settings.about.openLogsDir')}
      </Button>
    </div>
  );
}

/**
 * 「上传日志」按钮。
 *
 * 成功后必须给出上传编号(用户报障时口述给我们),所以保留可选择的编号并尝试复制到剪贴板。
 * 四种失败按 IPC 错误码给可区分的文案:未配置目标 / 未同意隐私政策 / 采到 0 条 / 上传失败。
 */
export function UploadLogsRow({ presentation = 'settings' }: LogSupportRowProps) {
  const { t } = useTranslation();
  const inDialog = presentation === 'dialog';
  const { state } = useLogUploadSettings();
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);
  const [uploadCode, setUploadCode] = useState<string | null>(null);

  const handleUpload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setUploading(true);
    try {
      const result = await window.electronAPI.uploadLogsNow();
      setUploadCode(result.uploadCode);
      toast.success(t('logSupport.uploaded', { code: result.uploadCode }));
      // 编号是这次上报唯一的可报凭据,顺手放进剪贴板,省得用户从 toast 里抄。
      try {
        await navigator.clipboard.writeText(result.uploadCode);
      } catch {
        // 剪贴板不可用不影响主流程 —— 编号保留在界面上，可手动选择复制。
      }
    } catch (err) {
      const code = extractIpcError(err)?.code;
      switch (code) {
        case 'LOG_UPLOAD_UNAVAILABLE':
          toast.error(t('settings.about.logUpload.errorUnavailable'));
          break;
        case 'PRIVACY_CONSENT_REQUIRED':
          toast.error(t('settings.about.logUpload.errorConsentRequired'));
          break;
        case 'LOG_UPLOAD_EMPTY':
          toast.error(t('settings.about.logUpload.errorEmpty'));
          break;
        case 'LOG_UPLOAD_BUSY':
          toast.error(t('settings.about.logUpload.errorBusy'));
          break;
        default:
          toast.error(t('settings.about.logUpload.errorFailed'));
      }
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  };

  const unavailableReason = !state.targetConfigured
    ? t('settings.about.logUpload.unavailableNotConfigured')
    : !state.privacyConsentAccepted
      ? t('settings.about.logUpload.unavailableNoConsent')
      : null;
  const descriptionClassName = inDialog
    ? 'text-12 leading-normal text-[var(--confirm-desc)]'
    : 'text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70';

  return (
    // Same inherited Settings row gutter as OpenLogsRow; not an additional dialog inset.
    <div className={cn('flex flex-col gap-1.5', !inDialog && 'px-[18px] py-4')}>
      {/* items-start:本行的说明有三段(用途 / 上传内容边界 / 不可用原因),按钮若垂直居中会浮在
          文字块中间;与标签对齐才和同页其它「标签 + 按钮」行(日志目录 / 服务条款)读起来一致。 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            id={inDialog ? undefined : 'settings-search-settings-about-logUpload-uploadLabel'}
            className={cn(
              'text-13',
              inDialog ? 'text-[var(--confirm-title)]' : 'text-[var(--settings-section-sublabel)]',
            )}
          >
            {t('settings.about.logUpload.uploadLabel')}
          </span>
          <p className={descriptionClassName}>
            {t(
              inDialog
                ? 'logSupport.uploadDescription'
                : 'settings.about.logUpload.uploadDescription',
            )}
          </p>
          {inDialog ? (
            <details className={descriptionClassName}>
              <summary className="w-fit cursor-pointer underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
                {t('logSupport.uploadDetails')}
              </summary>
              <p className="mt-2">{t('settings.about.logUpload.scopeDescription')}</p>
            </details>
          ) : (
            <p className={descriptionClassName}>{t('settings.about.logUpload.scopeDescription')}</p>
          )}
          {uploadCode && (
            <p
              role="status"
              className="select-text break-words text-13 leading-normal text-[var(--text-primary)]"
            >
              {t('logSupport.uploaded', { code: uploadCode })}
            </p>
          )}
          {unavailableReason !== null && (
            <p className={descriptionClassName}>{unavailableReason}</p>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void handleUpload()}
          disabled={!state.manualUploadAvailable || uploading || state.loading}
          loading={uploading}
          palette={inDialog ? 'confirmation' : 'default'}
          className={inDialog ? 'px-3' : '-mr-1 px-2.5'}
          title={t('settings.about.logUpload.uploadTooltip')}
        >
          {!inDialog && <Upload size={13} />}
          {t('settings.about.logUpload.uploadButton')}
        </Button>
      </div>
    </div>
  );
}
