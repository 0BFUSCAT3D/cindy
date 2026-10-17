import { ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { statEntry, type DirEntry } from '@cindy/file-browser-core';
import {
  createHtmlPreview,
  copyPreviewFile,
  previewLocation,
  type HtmlPreviewArgs,
} from './html-preview.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../filePathPolicy.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { createLogger } from '../logger.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { getDbClient } from '../localDb/client/current.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isSharedTaskPeer } from '@cindy/device-link';

const log = createLogger('html-preview');
export const HTML_PREVIEW_CHANNEL = 'maker:html-preview:open';
interface RemoteSource {
  stat(args: HtmlPreviewArgs, root: string, rel: string): Promise<Omit<DirEntry, 'name'>>;
  read(args: HtmlPreviewArgs, root: string, entry: DirEntry, signal?: AbortSignal): Promise<string>;
}

const active = new Set<() => Promise<void>>();
let preparing = 0;
let shuttingDown = false;
export async function disposeHtmlPreviews(): Promise<void> {
  shuttingDown = true;
  await Promise.allSettled([...active].map((close) => close()));
}
export function registerHtmlPreviewIpc(remote: RemoteSource): void {
  // Keep only references to managed cache files, never another copy of their bytes.
  type CachedFile = { metadata: DirEntry; path: string };
  const files = new Map<string, CachedFile>();
  const refreshing = new Set<string>();
  let cacheOwner: string | undefined;
  ipcMain.handle(HTML_PREVIEW_CHANNEL, async (event, args: HtmlPreviewArgs) => {
    assertTrustedAppRendererEvent(event);
    if (shuttingDown || preparing >= 8)
      throwIpcError('HTML_PREVIEW_TOO_LARGE', 'Preview capacity exceeded');
    preparing++;
    try {
      previewLocation(args);
      const scope = captureDataOwnerBroadcastScope();
      const ownerKey = scope.ownerScopeKey;
      const cacheable = !!ownerKey && !(args.origin.kind === 'device' && isSharedTaskPeer(args.origin.deviceId));
      if (cacheOwner !== ownerKey) { files.clear(); cacheOwner = ownerKey; }
      const keyOf = (root: string, rel: string) => JSON.stringify([ownerKey, args.origin, args.workdir, root, rel]);
      const selected = new Map<string, CachedFile>();
      const isCurrent = () => !shuttingDown && isDataOwnerBroadcastScopeCurrent(scope);
      const db = getDbClient().drizzle;
      // Finished snapshots are a bounded cache, not concurrent preparation slots.
      // External browsers cannot report tab closure; evict the oldest snapshot so
      // sequential opens (or failed browser launches) never block new previews for hours.
      while (active.size + preparing > 8) {
        const oldest = active.values().next().value;
        if (!oldest) break;
        await oldest();
      }
      if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
      const preview = await createHtmlPreview(args, {
        isCurrent,
        // Log status only: paths, signed URLs and page contents are not diagnostics.
        onResourceError: (status) => log.warn('Preview resource request failed', { status }),
        stat: async (root, rel) => {
          if (args.origin.kind !== 'local') {
            const key = keyOf(root, rel);
            const cached = cacheable ? files.get(key) : undefined;
            const stat = cached && await fs.stat(cached.path).catch(() => null);
            if (cached && stat?.isFile() && stat.size === cached.metadata.size) {
              selected.set(key, cached);
              return cached.metadata;
            }
            selected.delete(key);
            files.delete(key);
            return remote.stat(args, root, rel);
          }
          const real = await fs.realpath(path.join(root, rel));
          if (!isPathAllowedAgainst(real, getSensitiveMediaBlocklist()))
            throw new Error('BAD_ARGS');
          return statEntry(root, rel);
        },
        read: async (root, entry, signal) => {
          if (args.origin.kind !== 'local') {
            const key = keyOf(root, entry.relPath);
            const cached = selected.get(key);
            if (cached) return cached.path;
            const file = await remote.read(args, root, entry, signal);
            if (cacheable && isCurrent() && !signal?.aborted) files.set(key, { metadata: entry, path: file });
            return file;
          }
          const source = path.join(root, entry.relPath);
          const [rootReal, real] = await Promise.all([fs.realpath(root), fs.realpath(source)]);
          if (
            !real.startsWith(rootReal + path.sep) ||
            !isPathAllowedAgainst(real, getSensitiveMediaBlocklist())
          )
            throw new Error('BAD_ARGS');
          return real;
        },
        materialize: async (source, dest, expectedSize) => {
          // The temporary tree is a view of managed media, not another persistent media store.
          await copyPreviewFile(source, dest, expectedSize);
          // Start after copying: replacing the shared cache cannot invalidate this view.
          for (const [key, cached] of selected) {
            if (cached.path !== source || refreshing.has(key)) continue;
            refreshing.add(key);
            const [, , , root, rel] = JSON.parse(key) as string[];
            void (async () => {
              if (!isCurrent()) return;
              const metadata = await remote.stat(args, root, rel);
              if (!isCurrent() || metadata.type !== 'file') return;
              const entry = { ...metadata, name: cached.metadata.name };
              if (entry.size === cached.metadata.size && entry.mtimeMs === cached.metadata.mtimeMs) return;
              const file = await remote.read(args, root, entry);
              if (isCurrent()) files.set(key, { metadata: entry, path: file });
            })().catch(() => { /* Preserve the usable snapshot while offline. */ })
              .finally(() => refreshing.delete(key));
          }
          const file = await fs.open(dest, 'r');
          const probe = Buffer.alloc(8192);
          let mime: string | null;
          try {
            const { bytesRead } = await file.read(probe);
            mime = sniffMediaMime(probe.subarray(0, bytesRead));
          } finally {
            await file.close();
          }
          if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
          if (mime) {
            const assertStillValid = () => {
              if (!isCurrent()) throw new Error('PREVIEW_CANCELLED');
            };
            await ingestMedia(
              {
                filePath: dest,
                mimeType: mime,
                isCache: true,
                assertStillValid,
                // The server owns dest, not the managed blob. Cache eviction cannot
                // interrupt this snapshot, so it needs no persistent business ref.
                refs: [],
              },
              db,
            );
          }
          return dest;
        },
      });
      const close = async () => {
        clearTimeout(expiry);
        active.delete(close);
        await preview.close();
      };
      active.add(close);
      // External browser pages outlive a chat tab; retain snapshots until expiry/app shutdown.
      const expiry = setTimeout(
        () => {
          void close().catch(() => log.warn('Preview cleanup failed'));
        },
        2 * 60 * 60 * 1000,
      );
      expiry.unref();
      return { ok: true as const, url: preview.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /PREVIEW_TOO_LARGE|DIRECTORY_TOO_LARGE/.test(message)
        ? 'HTML_PREVIEW_TOO_LARGE'
        : /COMPLETE_DIRECTORY_LISTING_UNSUPPORTED|unknown.*(op|method)|METHOD_NOT_FOUND|CHANNEL_NOT_ALLOWED/i.test(
              message,
            )
          ? 'HTML_PREVIEW_UNSUPPORTED'
          : /NOT_FOUND|ENOENT/.test(message)
            ? 'NOT_FOUND'
            : 'BROWSER_FILE_OPEN_FAILED';
      log.warn('Preview preparation failed', { code });
      throwIpcError(code, 'Could not prepare HTML preview');
    } finally {
      preparing--;
    }
  });
}
