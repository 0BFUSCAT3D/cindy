import { useEffect, useRef, useState } from 'react';
import { Check, Download, Pencil, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { ScrollCapture } from '../../../shared/scrollCapture';
import type { RegionCaptureBegin } from '../../../shared/regionCapture';
import type { RegionScreenshotBitmap } from '../../../shared/regionScreenshot';
import { bitmapToImageData, type RegionScreenshotOverlayBridge } from './bridge';

/** The selection stays over the source app; only its thumbnail/actions take input. */
export function ScrollCaptureOverlay({ begin, token, bridge, onEdit }: {
  begin: RegionCaptureBegin;
  token: string;
  bridge: RegionScreenshotOverlayBridge;
  onEdit(image: RegionScreenshotBitmap): Promise<void>;
}) {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const runtime = useRef({ active: true, finishing: false, capture: new ScrollCapture(begin.first), bitmap: begin.first, pending: null as Promise<void> | null, automatic: false, stillFrames: 0, unmatchedSince: 0 });
  const [height, setHeight] = useState(begin.first.height);
  const [automatic, setAutomatic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('scrollHint');
  const [error, setError] = useState('');
  const layout = begin.scrollLayout!;

  function paint(image: RegionScreenshotBitmap, edge: 'start' | 'end' = 'start') {
    const target = canvas.current;
    if (!target) return;
    const source = document.createElement('canvas');
    source.width = image.width; source.height = image.height;
    source.getContext('2d')!.putImageData(bitmapToImageData(image), 0, 0);
    // Keep text at a stable scale as the capture grows. The preview scrolls;
    // fitting the entire long image into a fixed box would make it unreadable.
    const ratio = Math.min(1, (layout.preview.width - 32) / image.width);
    target.width = Math.max(1, Math.round(image.width * ratio));
    target.height = Math.max(1, Math.round(image.height * ratio));
    target.getContext('2d')!.drawImage(source, 0, 0, target.width, target.height);
    if (preview.current) preview.current.scrollTop = edge === 'end' ? preview.current.scrollHeight : 0;
  }

  async function changeAutomatic(enabled: boolean) {
    const state = runtime.current;
    if (state.finishing) return;
    const accepted = await bridge.autoScroll(token, enabled);
    if (!state.active || state.finishing) return;
    state.automatic = accepted && enabled;
    state.stillFrames = 0;
    setAutomatic(state.automatic);
    setError(accepted ? '' : 'autoUnavailable');
  }

  async function sample() {
    const state = runtime.current;
    const frame = await bridge.liveFrame(token, false, panel.current?.clientHeight);
    if (!frame || !state.active || state.finishing) return;
    if (state.automatic && frame.autoScrolling === false) {
      state.automatic = false; setAutomatic(false); setError('autoUnavailable');
    }
    const match = state.capture.add(frame.image);
    if (match === 'append' || match === 'prepend') {
      state.bitmap = state.capture.image();
      setHeight(state.bitmap.height); paint(state.bitmap, match === 'append' ? 'end' : 'start');
      state.stillFrames = 0; state.unmatchedSince = 0; setStatus('scrollHint'); setError('');
    } else if (match === 'unmatched') {
      state.unmatchedSince ||= performance.now();
      if (performance.now() - state.unmatchedSince > 1500) {
        if (state.bitmap.height > begin.first.height) setStatus('overlap');
        if (state.automatic) await changeAutomatic(false);
      }
    } else {
      state.unmatchedSince = 0;
      setStatus(match === 'limit' ? 'limit' : 'scrollHint');
      if (state.automatic && (match === 'limit' || ++state.stillFrames >= 8)) await changeAutomatic(false);
    }
  }

  async function finish(action: 'edit' | 'copy' | 'save') {
    const state = runtime.current;
    if (state.finishing) return;
    state.finishing = true; setBusy(true);
    state.automatic = false; setAutomatic(false);
    try {
      await bridge.holdCapture(token);
      await state.pending;
      if (!state.active) return;
      if (action === 'edit') await onEdit(state.bitmap);
      else if (!await bridge.exportImage(token, { action, selection: begin.selection, image: state.bitmap })) throw new Error('Export rejected');
    } catch {
      if (state.active) { state.finishing = false; setBusy(false); setError('exportFailed'); }
    }
  }

  useEffect(() => {
    const state = runtime.current;
    state.active = true;
    paint(begin.first);
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!state.active) return;
      if (state.finishing) { timer = setTimeout(tick, 200); return; }
      const started = performance.now();
      state.pending = sample().catch(() => { if (state.active && !state.finishing) { setError('captureFailed'); void changeAutomatic(false); } });
      await state.pending;
      state.pending = null;
      if (state.active) timer = setTimeout(tick, Math.max(0, 200 - (performance.now() - started)));
    };
    timer = setTimeout(tick, 200);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); bridge.cancel(token); }
      else if (event.key === 'Enter' || ((event.ctrlKey || event.metaKey) && ['c', 's'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); void finish(event.key.toLowerCase() === 's' ? 'save' : 'copy');
      }
    };
    window.addEventListener('keydown', key);
    return () => { state.active = false; clearTimeout(timer); window.removeEventListener('keydown', key); void bridge.holdCapture(token).catch(() => {}); };
    // A fresh session mounts a fresh overlay; mutable capture state lives in runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actions = [
    { key: 'edit', label: t('regionScreenshot.live.edit'), Icon: Pencil, run: () => void finish('edit') },
    { key: 'save', label: t('regionScreenshot.save'), Icon: Download, run: () => void finish('save') },
    { key: 'cancel', label: t('regionScreenshot.cancel'), Icon: X, run: () => bridge.cancel(token) },
    { key: 'copy', label: t('regionScreenshot.live.finish'), Icon: Check, run: () => void finish('copy') },
  ];
  const message = error === 'captureFailed' ? t('regionScreenshot.captureFailed') : t(`regionScreenshot.live.${error || status}`);
  return <div className="fixed inset-0 pointer-events-none select-none text-[var(--text-primary)]">
    <div aria-hidden className="absolute border border-[var(--text-primary)]" style={{ left: begin.selection.x - 1, top: begin.selection.y - 1, width: begin.selection.width + 2, height: begin.selection.height + 2, boxShadow: '0 0 0 1px var(--surface-elevated)' }} />
    <aside ref={panel} aria-label={t('regionScreenshot.live.preview')} className="absolute flex flex-col items-center overflow-hidden rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] pointer-events-auto" style={{ left: layout.preview.x, top: layout.preview.y, width: layout.preview.width, height: Math.min(layout.preview.height, Math.ceil(height * Math.min(1, (layout.preview.width - 32) / begin.first.width)) + 64) }}>
      <div className="shrink-0 py-1 text-11 tabular-nums">{begin.first.width} × {height}</div>
      <div ref={preview} className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden" style={{ scrollbarGutter: 'stable both-edges' }}>
        <canvas ref={canvas} className="mx-auto block max-w-full" />
      </div>
      {(error || status !== 'scrollHint') && <p role="alert" className="px-2 text-11 text-[var(--text-secondary)]">{message}</p>}
      <p role="status" className="sr-only">{message}</p>
      <div className="flex w-full shrink-0 justify-center gap-2 border-t border-[var(--border-default)] py-1">
        {actions.map(({ key, label, Icon, run }) => <Tip key={key} text={label} side="top"><Button size="xs" variant={key === 'copy' ? 'cta' : 'secondary'} className="w-7 px-0" aria-label={label} disabled={busy} onClick={run}><Icon size={16} aria-hidden /></Button></Tip>)}
      </div>
    </aside>
    <div className="absolute flex items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] pointer-events-auto" style={{ left: layout.auto.x, top: layout.auto.y, width: layout.auto.width, height: layout.auto.height }}>
      <Tip text={t('regionScreenshot.live.scrollHint')} side="top"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void changeAutomatic(!automatic)}>{t(`regionScreenshot.live.${automatic ? 'stopScroll' : 'autoScroll'}`)}</Button></Tip>
    </div>
  </div>;
}
