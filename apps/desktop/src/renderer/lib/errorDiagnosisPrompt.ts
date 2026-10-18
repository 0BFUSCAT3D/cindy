/**
 * errorDiagnosisPrompt — 错误卡「诊断」：把错误和出错任务链接预填进新任务草稿。
 *
 * 沿用 contacts / issue 预填入口的「不预创建会话」模式：只写 New Maker 草稿并复位
 * 工作区目标，调用方随后 navigate('/cc-agent/new')。不自动发送，用户确认后再发。
 */
import type { TFunction } from 'i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
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

/**
 * 新建任务页已有未发送的内容时不覆盖：诊断提示追加在原文之后，附件与浏览器评论原样保留。
 * 草稿为空时与其他预填入口一致，整体写入。
 */
export function prefillErrorDiagnosisDraft(prompt: string): void {
  const existing = getDraft(NEW_MAKER_DRAFT_KEY);
  const added = plainTextToTiptapDoc(prompt);
  const existingContent = existing?.text?.content ?? [];
  saveDraft(NEW_MAKER_DRAFT_KEY, {
    ...(existing?.browserComments?.length ? { browserComments: existing.browserComments } : {}),
    text: existingContent.length > 0
      ? { ...added, content: [...existingContent, ...(added.content ?? [])] }
      : added,
    attachments: existing?.attachments ?? [],
  });
  resetDraftWorkspaceTargets();
}
