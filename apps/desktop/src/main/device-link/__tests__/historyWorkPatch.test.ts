import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryMessageSource, HistoryViewPage } from '@cindy/maker-shared/message-window';
import { createHistoryViewReader, type HistoryPageShape } from '../../localDb/ipc/historyViewReader';
import {
  buildHistoryWorkPatch,
  historyWorkPatchKey,
  setHistoryWorkPageReader,
  thinkingDeltaUpdatesWorkLine,
} from '../historyViewPush';

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(1_700_000_000_000 + clock).toISOString();
}
function user(n: number): HistoryMessageSource {
  return { id: `m${n}`, clientId: `c${n}`, rowid: n, role: 'user', content: 'please work', createdAt: at() };
}
function assistant(n: number, text: string): HistoryMessageSource {
  return { id: `m${n}`, clientId: `c${n}`, rowid: n, role: 'assistant', content: text, createdAt: at() };
}
function toolUse(n: number, toolName: string, input: unknown): HistoryMessageSource {
  return { id: `m${n}`, clientId: `c${n}`, rowid: n, role: 'tool_use', content: { toolName, toolUseId: `t${n}`, input }, createdAt: at() };
}
function toolResult(n: number, useN: number, content: string): HistoryMessageSource {
  return { id: `m${n}`, clientId: `c${n}`, rowid: n, role: 'tool_result', toolUseId: `t${useN}`, content, createdAt: at() };
}
function thinking(n: number, text: string): HistoryMessageSource {
  return { id: `m${n}`, clientId: `c${n}`, rowid: n, role: 'thinking', content: text, createdAt: at() };
}

/** Outline reads omit bodies like the real Host; every write bumps the DB-wide revision. */
function host(source: HistoryMessageSource[]) {
  let writes = 0;
  const list = async (_sid: string, opts: { before?: string; after?: string; limit: number }) => {
    const start = opts.after ? source.findIndex((r) => r.id === opts.after) + 1 : 0;
    const end = opts.before ? source.findIndex((r) => r.id === opts.before) : source.length;
    const selected = source.slice(start, end);
    return (opts.after ? selected.slice(0, opts.limit) : selected.slice(-opts.limit)).reverse();
  };
  const reader = createHistoryViewReader({
    list,
    // Mirrors historyOutlineContent: bodies stay on disk, only grouping facts are read.
    outline: async (sid, opts) => (await list(sid, opts)).map((row) => {
      const content = row.content as { toolName?: string; toolUseId?: string; input?: Record<string, unknown> };
      if (row.role === 'thinking') return { ...row, content: { isRedacted: true } };
      if (row.role === 'tool_result') return { ...row, content: '' };
      if (row.role === 'tool_use') {
        return { ...row, content: { toolName: content.toolName, toolUseId: content.toolUseId,
          input: { file_path: content.input?.file_path, path: content.input?.path, command: content.input?.command } } };
      }
      return row;
    }),
    hydrate: async (_sid, ids) => source.filter((row) => ids.includes(row.id)),
    revision: async () => `db:${writes}`,
    anchor: async (_sid, id) => {
      const found = source.find((row) => row.id === id);
      if (!found) throw new Error('NOT_FOUND');
      return found;
    },
    running: () => true,
  });
  return {
    write(...rows: HistoryMessageSource[]) {
      source.push(...rows);
      writes += 1;
    },
    async page(): Promise<{ page: HistoryViewPage<HistoryMessageSource>; shape: HistoryPageShape }> {
      let shape: HistoryPageShape | undefined;
      const page = await reader.page('s', undefined, true, { workLines: true, onShape: (value) => { shape = value; } });
      return { page, shape: shape! };
    },
    reader,
  };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const bigOutput = (n: number) => `line ${n}: ${'output '.repeat(3000)}`;

afterEach(() => setHistoryWorkPageReader(null));

describe('running work lines', () => {
  it('attaches the latest five Host-projected lines to the running item without any body', async () => {
    const source = [user(0), assistant(1, 'Starting.')];
    let n = 2;
    for (let step = 0; step < 8; step += 1) {
      source.push(toolUse(n, 'Bash', { command: `pnpm test --filter pkg${step}` }), toolResult(n + 1, n, bigOutput(step)));
      n += 2;
    }
    source.push(thinking(n, `Now   I should\ncheck ${'the next thing '.repeat(40)}`));
    const { page, shape } = await host(source).page();
    const running = page.items.at(-1);
    if (running?.type !== 'work') throw new Error('missing running item');
    const lines = running.summary.lines!;
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toMatchObject({ kind: 'thinking', truncated: true });
    const last = lines.at(-1)!;
    expect(last.kind === 'thinking' ? last.text.length : Infinity).toBeLessThanOrEqual(160);
    expect(lines.slice(0, 4).every((line) => line.kind === 'tool' && line.status === 'done')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('output output');
    expect(shape.running.get(running.key)).toBe(running.summary.revision);
  });

  it('resolves intent from the full command before cutting it, so a long command keeps its intent', async () => {
    const command = `cat src/a.ts && ${'echo filler; '.repeat(80)}`;
    const source = [user(0), toolUse(1, 'Bash', { command, description: '' })];
    const { page } = await host(source).page();
    const running = page.items.at(-1);
    if (running?.type !== 'work') throw new Error('missing running item');
    const [line] = running.summary.lines!;
    if (line.kind !== 'tool' || line.descriptor.kind !== 'command') throw new Error('expected command line');
    expect(line.descriptor.command.length).toBeLessThanOrEqual(300);
    expect(line.status).toBe('running');
  });

  it('keeps the page shape stable across DB writes that touch only the running item', async () => {
    const source = [user(0), assistant(1, 'Earlier answer'), user(2), toolUse(3, 'Read', { file_path: '/repo/a.ts' })];
    const h = host(source);
    const first = await h.page();
    h.write(toolResult(4, 3, 'contents of a'), toolUse(5, 'Grep', { pattern: 'needle', path: '/repo' }));
    const second = await h.page();
    // Completed items carry a DB-wide revision suffix that changed; their fingerprints must not.
    expect(second.shape.fingerprints).toEqual(first.shape.fingerprints);
    const key = historyWorkPatchKey(first.shape, second.shape);
    expect(key).toBe(second.page.items.at(-1)!.key);
  });

  it('refuses a patch whenever anything besides the running item moved', async () => {
    const source = [user(0), toolUse(1, 'Read', { file_path: '/repo/a.ts' })];
    const h = host(source);
    const first = await h.page();
    h.write(toolResult(2, 1, 'ok'), assistant(3, 'Found it, continuing.'), toolUse(4, 'Read', { file_path: '/repo/b.ts' }));
    const second = await h.page();
    expect(historyWorkPatchKey(first.shape, second.shape)).toBeNull();
  });

  it('builds a patch against the delivered revision, reports no-ops, and refreshes on reshape', async () => {
    const source = [user(0), toolUse(1, 'Read', { file_path: '/repo/a.ts' })];
    const h = host(source);
    setHistoryWorkPageReader((sid, onShape) => h.reader.page(sid, undefined, true, { workLines: true, onShape }));
    const delivered = await h.page();
    expect(await buildHistoryWorkPatch('s', delivered.shape)).toEqual({ kind: 'unchanged' });

    h.write(toolResult(2, 1, 'ok'));
    const result = await buildHistoryWorkPatch('s', delivered.shape);
    if (result.kind !== 'patch') throw new Error(`expected patch, got ${result.kind}`);
    const running = delivered.page.items.at(-1)!;
    if (running.type !== 'work') throw new Error('missing running item');
    expect(result.patch.baseRevision).toBe(running.summary.revision);
    expect(result.patch.item.summary.lines!.at(-1)).toMatchObject({ kind: 'tool', status: 'done' });

    h.write(assistant(3, 'Done reading.'), user(4));
    expect((await buildHistoryWorkPatch('s', result.shape)).kind).toBe('refresh');
  });

  it('leaves an oversized summary to the page read and its frame handling', async () => {
    const source = [user(0), toolUse(1, 'Read', { file_path: '/repo/a.ts' })];
    const h = host(source);
    const delivered = await h.page();
    setHistoryWorkPageReader(async (sid, onShape) => {
      const page = await h.reader.page(sid, undefined, true, { workLines: true, onShape });
      const running = page.items.at(-1);
      if (running?.type === 'work') {
        running.summary.artifacts = Array.from({ length: 2000 }, (_, i) => ({ path: `/repo/out/${i}.png`, source: 'tool' as const, createdAt: '' }));
      }
      return page;
    });
    h.write(toolResult(2, 1, 'ok'));
    expect((await buildHistoryWorkPatch('s', delivered.shape)).kind).toBe('refresh');
  });

  it('costs a small fraction of the page re-read that each activity notice used to trigger', async () => {
    const source = [user(0), assistant(1, 'Plan: '.concat('details '.repeat(400)))];
    const h = host(source);
    setHistoryWorkPageReader((sid, onShape) => h.reader.page(sid, undefined, true, { workLines: true, onShape }));
    let delivered = (await h.page()).shape;
    let n = 2;
    let rereadBytes = 0;
    let patchBytes = 0;
    for (let step = 0; step < 30; step += 1) {
      h.write(toolUse(n, 'Read', { file_path: `/repo/file${step}.ts` }), toolResult(n + 1, n, bigOutput(step)));
      n += 2;
      const reread = await h.reader.page('s', undefined, true);
      rereadBytes += bytes(reread);
      const result = await buildHistoryWorkPatch('s', delivered);
      if (result.kind === 'patch') {
        patchBytes += bytes(result.patch);
        delivered = result.shape;
      } else {
        // The first activity opens a new group: the controller re-reads, as before.
        expect(step).toBe(0);
        const fresh = await h.page();
        patchBytes += bytes(fresh.page);
        delivered = fresh.shape;
      }
    }
    expect(patchBytes * 2).toBeLessThan(rereadBytes);
  });

  it('notifies thinking deltas only while they still change the single line', () => {
    const delta = (text: string, blockId = 'b1') => ({ sessionId: 's', event: { type: 'thinking', data: { stage: 'delta', blockId, text } } });
    expect(thinkingDeltaUpdatesWorkLine('s', delta('a'.repeat(100)))).toBe(true);
    expect(thinkingDeltaUpdatesWorkLine('s', delta('b'.repeat(100)))).toBe(true);
    expect(thinkingDeltaUpdatesWorkLine('s', delta('c'))).toBe(false);
    expect(thinkingDeltaUpdatesWorkLine('s', delta('d', 'b2'))).toBe(true);
    expect(thinkingDeltaUpdatesWorkLine('s', { sessionId: 's', event: { type: 'tool_use', data: {} } })).toBe(false);
  });
});
