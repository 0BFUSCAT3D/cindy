import { ipcMain } from 'electron';
import { withHtmlPreviewCsp } from '@cindy/maker-shared/file-preview';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { mountRemoteAppDocument, unmountRemoteAppDocument } from './mcp-apps/sandboxProtocol.js';

/** Reuse the isolated document store, without creating an MCP App or tool bridge. */
export function registerHtmlAnswerPreviewIpc(): void {
  ipcMain.handle('html-answer:preview', (event, input: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = input as { html?: unknown; viewId?: unknown } | null;
    const caller = `renderer:${event.sender.id}`;
    if (!value || typeof value !== 'object')
      throwIpcError('INVALID_PARAMS', 'HTML_ANSWER_INVALID_REQUEST');
    try {
      if (typeof value.viewId === 'string') {
        unmountRemoteAppDocument(value.viewId, caller);
        return null;
      }
      if (typeof value.html !== 'string') throw new Error('Invalid document');
      const viewId = mountRemoteAppDocument(
        { html: withHtmlPreviewCsp(value.html), prefersBorder: false },
        caller,
      );
      return { viewId, url: `cindy-mcp-app://${viewId}-view/resource` };
    } catch {
      throwIpcError('INVALID_PARAMS', 'HTML_ANSWER_PREVIEW_UNAVAILABLE');
    }
  });
}
