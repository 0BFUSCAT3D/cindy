import { i18n } from '@/i18n';
import type { MobileMessageGalleryImage } from '@/session/messageGallery';
import { buildMediaPayload } from '@/session/messagePayload';
import { isDesktopLocalMediaUrl, isDirectPreviewableMediaUrl } from '@/session/remoteMedia';
import { getSentAttachmentThumbUri } from '@/session/sentAttachmentThumbStore';
import type { MobileOutboxThumb } from '@/session/sessionOutbox';

/** The thumbnail button and gallery must open the same source, including before upload finishes. */
export function pendingSendGalleryImage(
  thumb: MobileOutboxThumb,
  displayedUri?: string | null,
): MobileMessageGalleryImage | null {
  const previewRef = thumb.previewRef ?? thumb.ossRef;
  const previewUri = displayedUri === undefined
    ? (previewRef ? getSentAttachmentThumbUri(previewRef) : null) ?? thumb.uri
    : displayedUri;
  // A materialized host reference opens the original through the existing resolver.
  // OSS upload references are lookup keys, never image URLs for the native viewer.
  const remoteUrl = isDesktopLocalMediaUrl(thumb.ossRef) || isDirectPreviewableMediaUrl(thumb.ossRef)
    ? thumb.ossRef : null;
  const localUrl = previewUri && (
    isDirectPreviewableMediaUrl(previewUri)
    || /^(?:file|ph|content|assets-library):\/\//.test(previewUri)
  ) ? previewUri : null;
  const url = remoteUrl ?? localUrl;
  if (!url) return null;
  const title = i18n.t('message.renderer.imageFallbackTitle');
  return {
    key: thumb.key,
    title,
    url,
    payload: buildMediaPayload({ kind: 'image', url, previewable: !isDesktopLocalMediaUrl(url) }, title),
    ...(localUrl ? { previewUri: localUrl } : {}),
  };
}
