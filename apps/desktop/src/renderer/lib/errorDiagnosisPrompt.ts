/**
 * errorDiagnosisPrompt — 错误卡「诊断」：把错误和出错任务链接预填进新任务草稿。
 *
 * 沿用 contacts / issue 预填入口的「不预创建会话」模式：只写 New Maker 草稿并复位
 * 工作区目标，调用方随后 navigate('/cc-agent/new')。不自动发送，用户确认后再发。
 */
import type { TFunction } from 'i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { resetDraftWorkspaceTargets } from '@/state/newMakerDraft';

export interface ErrorDiagnosisSource {
  /** 卡片上给用户看的错误提示。 */
  message: string;
  /** 展开详情里的原始错误。 */
  details: string;
  reason?: string | null;
}

export function buildErrorDiagnosisPrompt(
  t: TFunction,
  sessionUrl: string,
  source: ErrorDiagnosisSource,
): string {
  const details = redactSensitiveText(source.details).trim();
  return t('chat.errorBanner.diagnosePrompt', {
    sessionUrl,
    message: redactSensitiveText(source.message).trim(),
    details: source.reason ? `${details}\nreason: ${source.reason}` : details,
  });
}

export function prefillErrorDiagnosisDraft(prompt: string): void {
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    text: plainTextToTiptapDoc(prompt),
    attachments: [],
  });
  resetDraftWorkspaceTargets();
}
