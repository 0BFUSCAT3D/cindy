import type { RemoteSerializedAttachment } from '@/session/types';

export interface SentMessageImagePreview {
  attachmentId: string;
  name: string;
  sourceRef: string;
  sha256?: string;
  uri: string | null;
  galleryImageKey?: string;
}

export type SentMessageImagePreviews = Map<string, readonly (SentMessageImagePreview | null)[]>;
export type GetSentMessageImagePreview = (
  clientId: string, imageIndex: number, name: string, attachmentId?: string, sha256?: string, sourceRef?: string,
) => SentMessageImagePreview | undefined;

const messageKey = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);

/** Known attachments keep their identity when a queue edit changes their position. */
export const sentImageGalleryKey = (clientId: string, attachmentId: string): string => `${clientId}-attachment:${attachmentId}`;

/** Presentation-only attachment identities, with optional local pixels for immediate previews. */
export function rememberSentMessageImagePreviews(
  previews: SentMessageImagePreviews,
  sessionId: string,
  clientId: string,
  attachments: readonly RemoteSerializedAttachment[],
  previewOf: (attachment: RemoteSerializedAttachment) => string | null | undefined,
  galleryKeyOf?: (attachment: RemoteSerializedAttachment) => string | undefined,
): void {
  const key = messageKey(sessionId, clientId);
  const previous = previews.get(key);
  const images = attachments.filter((attachment) => attachment.category === 'image').map((attachment) => {
    const uri = previewOf(attachment);
    const prior = previous?.find((entry) => entry?.attachmentId === attachment.id);
    // Preserve the outbox identity through URL materialization; a replaced file ID cannot inherit it.
    const galleryImageKey = galleryKeyOf?.(attachment) ?? prior?.galleryImageKey;
    return { attachmentId: attachment.id, name: attachment.originalName ?? attachment.name,
      sourceRef: uri || !prior?.uri ? attachment.url ?? attachment.path : prior.sourceRef,
      sha256: attachment.sha256, uri: uri || prior?.uri || null,
      ...(galleryImageKey ? { galleryImageKey } : {}) };
  });
  // Replace the complete snapshot on edit, including removed images and missing previews.
  previews.delete(key);
  if (images.length === 0) return;
  previews.set(key, images);
  while (previews.size > 64) previews.delete(previews.keys().next().value!);
}

export function getSentMessageImagePreview(
  previews: SentMessageImagePreviews,
  sessionId: string,
  clientId: string,
  imageIndex: number,
  name: string,
  attachmentId?: string,
  sha256?: string,
  sourceRef?: string,
): SentMessageImagePreview | undefined {
  const entries = previews.get(messageKey(sessionId, clientId));
  if (attachmentId) return entries?.find((entry) => entry?.attachmentId === attachmentId) ?? undefined;
  // Formal content omits file IDs. Prove the pixels still match before reusing a local image;
  // a same-name queue edit on another device must never resurrect the old preview.
  const matches = (entry: SentMessageImagePreview | null | undefined): entry is SentMessageImagePreview => (
    !!entry && entry.name === name && (!!sha256 && entry.sha256 === sha256 || entry.sourceRef === sourceRef)
  );
  const indexed = entries?.[imageIndex];
  if (matches(indexed)) return indexed;
  // Remote queue edits can move an image without updating this local snapshot. Only a unique,
  // proven content match may reconnect it; ambiguous same-name images cannot share identity.
  const candidates = entries?.filter(matches);
  return candidates?.length === 1 ? candidates[0] : undefined;
}
