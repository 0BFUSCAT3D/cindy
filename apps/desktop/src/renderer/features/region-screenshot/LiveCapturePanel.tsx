import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MAX_RECORDING_MS, type RegionCaptureBegin } from '../../../shared/regionCapture';
import type { RegionScreenshotBitmap } from '../../../shared/regionScreenshot';
import { bitmapToImageData, type RegionScreenshotOverlayBridge } from './bridge';
import { CaptureRecorder } from './captureRecorder';
import { SCREENSHOT_INK } from './screenshotColors';

type Phase = 'ready' | 'capturing' | 'paused' | 'finishing' | 'done';
type Point = { x: number; y: number };
type Mark = { kind: 'pen' | 'arrow' | 'rect'; points: Point[] };

export function LiveCapturePanel({ begin, token, bridge, autoStart = false }: { begin: RegionCaptureBegin; token: string; bridge: RegionScreenshotOverlayBridge; autoStart?: boolean }) {
  const { t } = useTranslation();
  const preview = useRef<HTMLCanvasElement>(null);
  const runtime = useRef({
    phase: (autoStart ? 'capturing' : 'ready') as Phase,
    active: true, inFlight: null as Promise<void> | null, recorder: null as CaptureRecorder | null,
    canvas: null as HTMLCanvasElement | null,
    imageData: undefined as ImageData | undefined,
    bitmap: begin.first, marks: [] as Mark[], draft: null as Mark | null,
    showCursor: true, showKeys: false, elapsed: 0, startedAt: 0, lastKeys: '', keysUntil: 0,
  });
  const [phase, setPhase] = useState<Phase>(runtime.current.phase);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [cursor, setCursor] = useState(true);
  const [keys, setKeys] = useState(false);
  const [tool, setTool] = useState<Mark['kind'] | null>(null);
  const [result, setResult] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [saving, setSaving] = useState(false);
  const currentTime = () => runtime.current.elapsed + (runtime.current.phase === 'capturing' ? performance.now() - runtime.current.startedAt : 0);
  const changePhase = (next: Phase) => { runtime.current.phase = next; setPhase(next); };

  function paint(bitmap: RegionScreenshotBitmap, pointer: Point | null = null) {
    const state = runtime.current;
    state.canvas ??= document.createElement('canvas');
    const canvas = state.canvas;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) { canvas.width = bitmap.width; canvas.height = bitmap.height; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    state.imageData = bitmapToImageData(bitmap, state.imageData);
    ctx.putImageData(state.imageData, 0, 0);
    {
      ctx.strokeStyle = SCREENSHOT_INK.red;
      ctx.lineWidth = Math.max(2, bitmap.width / 350);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const mark of state.draft ? [...state.marks, state.draft] : state.marks) {
        const points = mark.points.map((point) => ({ x: point.x * bitmap.width, y: point.y * bitmap.height }));
        const first = points[0], last = points[points.length - 1];
        if (!first || !last) continue;
        ctx.beginPath();
        if (mark.kind === 'rect') ctx.rect(first.x, first.y, last.x - first.x, last.y - first.y);
        else {
          ctx.moveTo(first.x, first.y);
          for (const point of mark.kind === 'arrow' ? [last] : points.slice(1)) ctx.lineTo(point.x, point.y);
          if (mark.kind === 'arrow') {
            const angle = Math.atan2(last.y - first.y, last.x - first.x), length = ctx.lineWidth * 5;
            for (const delta of [-0.5, 0.5]) { ctx.moveTo(last.x, last.y); ctx.lineTo(last.x - length * Math.cos(angle + delta), last.y - length * Math.sin(angle + delta)); }
          }
        }
        ctx.stroke();
      }
      if (state.showCursor && pointer) {
        ctx.fillStyle = SCREENSHOT_INK.white; ctx.strokeStyle = SCREENSHOT_INK.black; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(pointer.x + 5, pointer.y + 19); ctx.lineTo(pointer.x + 9, pointer.y + 12); ctx.lineTo(pointer.x + 16, pointer.y + 11); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      if (state.showKeys && state.keysUntil > performance.now()) {
        ctx.font = `${Math.max(16, bitmap.width / 40)}px sans-serif`;
        ctx.fillStyle = SCREENSHOT_INK.black;
        const width = ctx.measureText(state.lastKeys).width;
        ctx.fillRect(8, bitmap.height - 42, width + 20, 34);
        ctx.fillStyle = SCREENSHOT_INK.white; ctx.fillText(state.lastKeys, 18, bitmap.height - 18);
      }
    }
    const target = preview.current;
    if (target) {
      if (target.width !== bitmap.width || target.height !== bitmap.height) {
        target.width = bitmap.width; target.height = bitmap.height;
      }
      target.getContext('2d')!.drawImage(canvas, 0, 0);
    }
  }

  async function sample() {
    const state = runtime.current;
    const frame = await bridge.liveFrame(token, state.showKeys);
    if (!state.active || state.phase !== 'capturing' || !frame) return;
    {
      state.bitmap = frame.image;
      if (state.showKeys && frame.keys === null) { setError('keysUnavailable'); state.showKeys = false; setKeys(false); }
      if (frame.keys?.length) { state.lastKeys = frame.keys.join(' + '); state.keysUntil = performance.now() + 650; }
      paint(frame.image, frame.cursor);
      if (!state.recorder) {
        state.startedAt = performance.now(); state.elapsed = 0;
        state.recorder = new CaptureRecorder(state.canvas!, begin.mode === 'gif' ? 'gif' : 'webm', () => { setStatus('limit'); void finish(); });
      }
      state.recorder.add(currentTime());
      setElapsed(Math.floor(currentTime() / 1000) * 1000);
      if (currentTime() >= MAX_RECORDING_MS) { setStatus('limit'); queueMicrotask(() => void finish()); }
    }
  }

  useEffect(() => {
    const state = runtime.current;
    state.active = true; state.startedAt = performance.now();
    paint(begin.first);
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!state.active) return;
      const tickStarted = performance.now();
      if (state.phase === 'capturing') {
        state.inFlight = sample().catch(() => {
          if (!state.active || state.phase !== 'capturing') return;
          state.elapsed = currentTime();
          state.recorder?.pause(state.elapsed);
          changePhase('paused'); setError('captureFailed');
        });
        await state.inFlight;
        state.inFlight = null;
      }
      if (state.active) timer = setTimeout(tick, Math.max(0, 100 - (performance.now() - tickStarted)));
    };
    timer = setTimeout(tick, 250);
    return () => { state.active = false; clearTimeout(timer); state.recorder?.dispose(); };
    // A capture's lifetime is the component's lifetime; all changing options live in runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pause() {
    const state = runtime.current;
    if (state.phase === 'capturing') {
      state.elapsed = currentTime(); state.recorder?.pause(state.elapsed); changePhase('paused'); setStatus('paused');
      void bridge.holdCapture(token).catch(() => {});
    } else {
      state.startedAt = performance.now(); state.recorder?.resume(); changePhase('capturing'); setError(''); setStatus('recording');
    }
  }

  async function finish() {
    const state = runtime.current;
    if (state.phase === 'done' || state.phase === 'finishing') return;
    const at = currentTime();
    changePhase('finishing');
    // Finish after any in-flight sample; it will see the changed phase and discard its frame.
    await state.inFlight;
    if (!state.active) return;
    try {
      await bridge.holdCapture(token);
      {
        if (!state.recorder) { changePhase('ready'); return; }
        const bytes = await state.recorder.finish(at);
        if (!state.active) return;
        setResult(bytes);
      }
      changePhase('done'); setStatus('done');
    } catch { if (state.active) { setError('encodeFailed'); changePhase('done'); } }
  }

  async function saveRecording() {
    if (!result) return;
    setSaving(true);
    try {
      if (await bridge.saveRecording(token, result, begin.mode === 'gif' ? 'gif' : 'webm')) setStatus('saved');
    } catch { setError('exportFailed'); }
    finally { if (runtime.current.active) setSaving(false); }
  }

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }

  return <div className="flex h-screen flex-col gap-2 overflow-auto bg-[var(--surface)] p-3 text-12 text-[var(--text-primary)]">
    <div className="flex items-center justify-between gap-2 select-none">
      <span>{t(`regionScreenshot.live.${begin.mode}`)} · {`${Math.floor(elapsed / 60_000)}:${String(Math.floor(elapsed / 1000) % 60).padStart(2, '0')}`}</span>
      <Button size="xs" variant="secondary" tone="quiet" disabled={saving || phase === 'finishing'} onClick={() => bridge.cancel(token)}>{t('regionScreenshot.cancel')}</Button>
    </div>
    <div className="flex min-h-12 flex-1 items-center justify-center overflow-hidden">
      <canvas ref={preview} aria-label={t('regionScreenshot.live.preview')} className="block max-h-full max-w-full" style={{ objectFit: 'contain', cursor: tool ? 'crosshair' : 'default' }}
        onPointerDown={(event) => {
          if (!tool || phase === 'done' || phase === 'finishing') return;
          event.currentTarget.setPointerCapture(event.pointerId);
          runtime.current.draft = { kind: tool, points: [point(event)] };
        }}
        onPointerMove={(event) => {
          const draft = runtime.current.draft;
          if (!draft) return;
          if (draft.points.length < 4000) draft.points.push(point(event));
          paint(runtime.current.bitmap);
        }}
        onPointerUp={() => {
          const state = runtime.current;
          if (state.draft && state.marks.length < 100) state.marks.push(state.draft);
          state.draft = null; paint(state.bitmap);
        }} onPointerCancel={() => { runtime.current.draft = null; paint(runtime.current.bitmap); }} />
    </div>
    {phase !== 'done' && <>
      <div className="flex flex-wrap items-center gap-2 select-none">
        <label className="flex min-h-7 items-center gap-1"><input type="checkbox" checked={cursor} onChange={(event) => { setCursor(event.target.checked); runtime.current.showCursor = event.target.checked; }} />{t('regionScreenshot.live.cursor')}</label>
        <label className="flex min-h-7 items-center gap-1"><input type="checkbox" checked={keys} onChange={(event) => { setKeys(event.target.checked); runtime.current.showKeys = event.target.checked; runtime.current.lastKeys = ''; }} />{t('regionScreenshot.live.keys')}</label>
      </div>
      <div className="flex flex-wrap gap-1">
        {(['pen', 'arrow', 'rect'] as const).map((kind) => <Button key={kind} size="xs" variant="secondary" tone={tool === kind ? 'default' : 'quiet'} aria-pressed={tool === kind} onClick={() => setTool(tool === kind ? null : kind)}>{t(`regionScreenshot.tools.${kind}`)}</Button>)}
        <Button size="xs" variant="secondary" tone="quiet" onClick={() => { runtime.current.marks.pop(); paint(runtime.current.bitmap); }}>{t('regionScreenshot.undo')}</Button>
      </div>
    </>}
    <p role={error ? 'alert' : 'status'} className={error ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]'}>{t(`regionScreenshot.live.${error || status || (phase === 'ready' ? 'recordHint' : phase === 'paused' ? 'paused' : phase === 'done' ? 'done' : 'recording')}`)}</p>
    <div className="flex flex-wrap items-center gap-2">
      {phase !== 'done' && phase !== 'finishing' && <Button size="xs" variant="secondary" onClick={pause}>{t(`regionScreenshot.live.${phase === 'ready' ? 'start' : phase === 'capturing' ? 'pause' : 'resume'}`)}</Button>}
      {phase !== 'ready' && phase !== 'done' && <Button size="xs" variant="cta" disabled={phase === 'finishing'} onClick={() => void finish()}>{t('regionScreenshot.live.finish')}</Button>}
      {phase === 'done' && result && <Button size="xs" variant="cta" disabled={saving} onClick={() => void saveRecording()}>{t('regionScreenshot.save')}</Button>}
    </div>
  </div>;
}
