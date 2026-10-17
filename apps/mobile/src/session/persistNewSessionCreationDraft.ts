import { i18n } from '@/i18n';
import type { DurableOutboxRecord } from './durableOutbox';
import type { MobileLocalAttachmentUploadCandidate } from './mobileLocalAttachmentUpload';
import { durableOutboxUploadUri, outboxAttachmentNeedsLocalBytes, removeRetainedOutboxFiles, retainOutboxFile } from './durableOutboxFiles';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';

/** Save attachment bytes before the form reserves a worktree or hands off creation. */
export async function persistNewSessionCreationDraft({ record, recovering, getUploadedSource, isCurrent }: {
  record: DurableOutboxRecord;
  recovering: DurableOutboxRecord | null | undefined;
  getUploadedSource: (id: string) => MobileLocalAttachmentUploadCandidate | undefined;
  isCurrent: () => boolean;
}): Promise<DurableOutboxRecord | null> {
  let saved = { ...record, uploads: [] as DurableOutboxRecord['uploads'] };
  let committed = false;
  try {
    for (let slot = 0; slot < saved.item.attachmentSlots.length; slot++) {
      const attachment = saved.item.attachmentSlots[slot];
      if (!attachment) continue;
      const source = getUploadedSource(attachment.id);
      const oldSlot = recovering?.item.attachmentSlots.findIndex(a => a?.id === attachment.id);
      const oldUpload = recovering?.uploads.find(u => u.slot === oldSlot);
      if (source) saved.uploads.push(await retainOutboxFile(saved, slot, source));
      else if (recovering && oldUpload) saved.uploads.push(await retainOutboxFile(saved, slot, {
        ...oldUpload, uri: durableOutboxUploadUri(recovering, oldUpload),
      }));
      else if (outboxAttachmentNeedsLocalBytes(attachment)) {
        throw new Error(i18n.t('session.screen.attachmentsNotCarriedBack', { count: 1 }));
      }
    }
    if (!isCurrent()) return null;
    if (recovering) {
      const latest = getCurrentMobileOutboxRecords().find(r => r.item.clientId === saved.item.clientId
        && r.item.sessionId === recovering.item.sessionId);
      if (latest !== recovering || latest.prepared) throw new Error('OUTBOX_STALE_WRITE');
      saved = await mobileDurableOutbox.update(latest, saved);
    } else await mobileDurableOutbox.add(saved);
    committed = true;
    return saved;
  } finally {
    if (!committed) await removeRetainedOutboxFiles(saved).catch(() => undefined);
  }
}
