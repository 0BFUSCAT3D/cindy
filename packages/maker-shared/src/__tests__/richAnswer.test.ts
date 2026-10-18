import { describe, expect, it } from 'vitest';
import { RichAnswerStream, RichInteractionMemory, hasRichAnswer, splitRichAnswer, richDefaults, richEvaluate, richLabel, richResolvedValues, richChart, richCalculationUnavailable } from '../richAnswer';
// Tier 1: actual stream reducer. Regression targets are partial transport, edits,
// replay and preservation of user input; no DOM/source-string contracts.
const line = (seq: number, op: Record<string, unknown>) => JSON.stringify({ seq, ...op }) + '\n';
describe('streaming answer documents', () => {
  it('commits complete operations before the closing fence without exposing partial protocol', () => {
    const first = line(1, { op: 'create', id: 'title', kind: 'heading', props: { text: '你好' } });
    const second = line(2, { op: 'append', id: 'title', text: '，世界' });
    const parser = new RichAnswerStream();
    const input = 'Introduction\n```cindy-ui\n' + first + second;
    for (let length = 0; length <= input.length; length++) {
      const parts = splitRichAnswer(input.slice(0, length));
      const part = parts.find(p => p.kind === 'rich');
      if (!part) continue;
      const doc = parser.update(part.source, part.complete);
      const expected = length >= input.length ? '你好，世界' : length >= input.length - second.length ? '你好' : undefined;
      expect(doc.nodes.get('title')?.props.text).toBe(expected);
      expect(doc.issues).toBe(0);
    }
    expect(hasRichAnswer('```cindy-ui')).toBe(true);
    expect(hasRichAnswer('````markdown\n```cindy-ui\n{}\n```\n````')).toBe(false);
  });
  it('replays source snapshots, ignores duplicate operations and never mutates earlier snapshots', () => {
    const create = line(1, { op: 'create', id: 'a', kind: 'text', props: { text: 'one' } });
    const append = line(2, { op: 'append', id: 'a', text: ' two' });
    const parser = new RichAnswerStream(), first = parser.update(create);
    const next = parser.update(create + append + append);
    expect(next.nodes.get('a')?.props.text).toBe('one two');
    expect(first.nodes.get('a')?.props.text).toBe('one');
    expect(new RichAnswerStream().update(create + append).nodes).toEqual(next.nodes);
    expect(parser.update(create).nodes.get('a')?.props.text).toBe('one');
  });
  it('keeps user-edited state while model defaults and calculated data change', () => {
    const parser = new RichAnswerStream(), memory = new RichInteractionMemory();
    const source = line(1, { op: 'create', id: 'months', kind: 'range', props: { default: 6 } }) + line(2, { op: 'create', id: 'cost', kind: 'stat', props: { value: { op: 'mul', args: [{ ref: 'months' }, 10] } } });
    let doc = parser.update(source);
    memory.set('owner/device/message', { months: 9 });
    doc = parser.update(source + line(3, { op: 'patch', id: 'months', props: { default: 12 } }));
    const values = { ...richDefaults(doc), ...memory.get('owner/device/message') };
    expect(richLabel(doc.nodes.get('cost')!, values)).toBe('90');
    expect(memory.get('other-owner/device/message')).toEqual({});
    expect(richEvaluate({ op: 'div', args: [1, 0] }, values)).toBeUndefined();
  });
  it('moves and removes subtrees and isolates invalid updates from existing readable content', () => {
    const ops = [
      { op: 'create', id: 'group', kind: 'stack' },
      { op: 'create', id: 'text', kind: 'text', parent: 'group', props: { text: 'Readable' } },
      { op: 'move', id: 'group', parent: 'group' },
      { op: 'move', id: 'text', parent: 'root' },
      { op: 'remove', id: 'group' },
    ];
    const doc = new RichAnswerStream().update(ops.map((op, i) => line(i + 1, op)).join(''));
    expect(doc.roots).toEqual(['text']);
    expect(doc.nodes.get('text')?.props.text).toBe('Readable');
    expect(doc.issues).toBe(1);
  });
});
it('restores persisted controls without overwriting input entered during a slow load', async () => {
  let release!: (value: string | null) => void;
  let persisted = '';
  const memory = new RichInteractionMemory({
    read: () => new Promise(resolve => { release = resolve; }),
    write: async value => { persisted = value; },
  });
  const loading = memory.load();
  memory.set('owner/device/message', { months: 9 });
  release(JSON.stringify({ version: 1, entries: [['owner/device/message', { months: 2, enabled: true }]] }));
  await loading;
  expect(memory.get('owner/device/message')).toEqual({ months: 9, enabled: true });
  await memory.flush();
  const restored = new RichInteractionMemory({ read: async () => persisted, write: async () => {} });
  await restored.load();
  expect(restored.get('owner/device/message')).toEqual({ months: 9, enabled: true });
});

// Tier 1: a real Claude comparison referenced calculated stat IDs. Previously
// totals were right but the winner, savings and chart silently treated them as zero.
it('resolves calculated references and updates dependent labels and charts after input', () => {
  const source = [
    { id: 'months', kind: 'range', props: { default: 6 } },
    { id: 'extra', kind: 'check', props: { default: false } },
    { id: 'saving', kind: 'stat', props: { value: { op: 'sub', args: [{ ref: 'monthly' }, { ref: 'yearly' }] } } },
    { id: 'monthly', kind: 'stat', props: { value: { op: 'mul', args: [{ ref: 'months' }, { op: 'if', args: [{ ref: 'extra' }, 25, 20] }] } } },
    { id: 'yearly', kind: 'stat', props: { value: { op: 'add', args: [180, { op: 'if', args: [{ ref: 'extra' }, { op: 'mul', args: [5, { ref: 'months' }] }, 0] }] } } },
    { id: 'winner', kind: 'text', props: { value: { op: 'if', args: [{ op: 'gt', args: [{ ref: 'saving' }, 0] }, 'yearly', 'monthly'] } } },
    { id: 'chart', kind: 'chart', props: { data: [{ label: 'Monthly', value: { ref: 'monthly' } }, { label: 'Yearly', value: { ref: 'yearly' } }] } },
  ].map((node, i) => line(i + 1, { op: 'create', ...node })).join('');
  const doc = new RichAnswerStream().update(source, true);
  const initial = richResolvedValues(doc);
  expect(richLabel(doc.nodes.get('winner')!, initial)).toBe('monthly');
  const edited = richResolvedValues(doc, { months: 12, extra: true });
  expect(richLabel(doc.nodes.get('saving')!, edited)).toBe('60');
  expect(richLabel(doc.nodes.get('winner')!, edited)).toBe('yearly');
  expect(richChart(doc.nodes.get('chart')!, edited).map(x => x.value)).toEqual([300, 240]);
});
it('keeps missing, cyclic and invalid calculations unavailable instead of reporting zero', () => {
  const source = line(1, { op: 'create', id: 'a', kind: 'stat', props: { value: { ref: 'b' } } });
  const parser = new RichAnswerStream();
  let doc = parser.update(source);
  expect(richCalculationUnavailable(doc.nodes.get('a')!, richResolvedValues(doc))).toBe(true);
  doc = parser.update(source + line(2, { op: 'create', id: 'b', kind: 'stat', props: { value: { ref: 'a' } } }));
  expect(richLabel(doc.nodes.get('a')!, richResolvedValues(doc))).toBe('—');
  doc = parser.update(source + line(2, { op: 'create', id: 'b', kind: 'stat', props: { value: 25 } }));
  expect(richLabel(doc.nodes.get('a')!, richResolvedValues(doc))).toBe('25');
  expect(richEvaluate({ op: 'add', args: ['', 2] }, {})).toBeUndefined();
  expect(richEvaluate({ op: 'concat', args: Array(32).fill({ ref: 'text' }) }, { text: 'a'.repeat(4096) })).toBeUndefined();
});
