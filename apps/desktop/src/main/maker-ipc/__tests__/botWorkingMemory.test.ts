import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));

import {
  applyWorkingMemoryProposal,
  buildWorkingMemoryRefreshNote,
  createWorkingMemoryRefreshRegistry,
  emptyWorkingMemory,
  isWorkingMemoryFresh,
  parseWorkingMemory,
  readBotWorkingMemory,
  renderWorkingMemory,
  WORKING_MEMORY_HEADING,
  WORKING_MEMORY_LIMITS,
  workingMemoryForReview,
  workingMemoryPath,
  WorkingMemoryRevisionConflict,
  writeBotWorkingMemory,
  type BotWorkingMemory,
} from '../botWorkingMemory';

const messages = [
  { id: 'u1', role: 'user', text: '周五前把周报模板改成先结论后细节,别再用旧格式了' },
  { id: 'a1', role: 'assistant', text: '好的,我周五前把周报模板改成先结论后细节,改完发你确认' },
  { id: 't1', role: 'tool_result', text: 'report-template.md written' },
];

describe('applyWorkingMemoryProposal', () => {
  const now = 1_700_000_000_000;

  it('admits new items only with a quote from a user or assistant message and keeps their message id', () => {
    const next = applyWorkingMemoryProposal(
      null,
      {
        threads: [{ text: '改周报模板', status: 'active', evidence: { messageId: 'u1', quote: '周报模板改成先结论后细节' } }],
        commitments: [
          { text: '周五前改完周报模板并发用户确认', trigger: '周五前', evidence: { messageId: 'a1', quote: '周五前把周报模板改成先结论后细节' } },
          { text: '凭空捏造的承诺', evidence: { messageId: 'a1', quote: 'not said' } },
          { text: '工具结果不能作为新承诺的证据', evidence: { messageId: 't1', quote: 'report-template.md written' } },
        ],
        waiting: [],
        corrections: [{ text: '不再用旧格式', evidence: { messageId: 'u1', quote: '别再用旧格式' } }],
        recentlyDone: [],
        resolved: [],
      },
      messages,
      { now, coveredThroughRowid: 42 },
    );
    expect(next.threads.map((t) => t.text)).toEqual(['改周报模板']);
    expect(next.commitments.map((c) => c.text)).toEqual(['周五前改完周报模板并发用户确认']);
    expect(next.commitments[0]).toMatchObject({ messageId: 'a1', trigger: '周五前' });
    expect(next.corrections[0]).toMatchObject({ text: '不再用旧格式', messageId: 'u1' });
    expect(next.coveredThroughRowid).toBe(42);
  });

  it('carries unchanged items verbatim without evidence, keeps omitted ones, and drops only evidenced resolutions', () => {
    const previous: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      revision: 3,
      coveredThroughRowid: 10,
      commitments: [
        { id: 'c1', text: '周五前改完周报模板', updatedAt: 1, messageId: 'old' },
        { id: 'c2', text: '给设计稿加暗色模式', updatedAt: 2 },
        { id: 'c3', text: '把测试补上', updatedAt: 3 },
      ],
    };
    const next = applyWorkingMemoryProposal(
      previous,
      {
        threads: [],
        // c1 原文沿用(无证据也行);c2 没提到 → 保留;c3 有工具证据的 resolved → 删除。
        commitments: [{ text: '周五前改完周报模板' }],
        waiting: [],
        corrections: [],
        recentlyDone: [{ text: '测试已补上', evidence: { messageId: 'a1', quote: '改完发你确认' } }],
        resolved: [
          { text: '把测试补上', evidence: { messageId: 't1', quote: 'report-template.md written' } },
          { text: '给设计稿加暗色模式', evidence: { messageId: 'a1', quote: 'never said this' } },
        ],
      },
      messages,
      { now, coveredThroughRowid: 5 },
    );
    expect(next.commitments.map((c) => c.text)).toEqual(['周五前改完周报模板', '给设计稿加暗色模式']);
    expect(next.commitments[0]).toMatchObject({ id: 'c1', messageId: 'old', updatedAt: now });
    expect(next.recentlyDone.map((d) => d.text)).toEqual(['测试已补上']);
    // 水位只前进不后退。
    expect(next.coveredThroughRowid).toBe(10);
  });

  it('caps each section to its limit keeping the newest', () => {
    const previous: BotWorkingMemory = {
      ...emptyWorkingMemory(),
      threads: Array.from({ length: WORKING_MEMORY_LIMITS.threads }, (_, i) => ({
        id: `t${i}`, text: `旧线索 ${i}`, status: 'active' as const, updatedAt: i + 1,
      })),
    };
    const next = applyWorkingMemoryProposal(
      previous,
      { threads: [{ text: '新线索', evidence: { messageId: 'u1', quote: '周报模板' } }], commitments: [], waiting: [], corrections: [], recentlyDone: [], resolved: [] },
      messages,
      { now, coveredThroughRowid: 1 },
    );
    expect(next.threads).toHaveLength(WORKING_MEMORY_LIMITS.threads);
    expect(next.threads[0]!.text).toBe('新线索');
    expect(next.threads.map((t) => t.text)).not.toContain('旧线索 0');
  });
});

describe('renderWorkingMemory', () => {
  const memory: BotWorkingMemory = {
    ...emptyWorkingMemory(),
    corrections: [{ id: 'x', text: '先结论后细节', supersedes: '旧格式', messageId: 'u1', updatedAt: 1 }],
    commitments: [{ id: 'c', text: '周五前改完周报模板', trigger: '周五前', updatedAt: 1 }],
    waiting: [{ id: 'w', text: '用户确认配色', on: 'user', updatedAt: 1 }],
    threads: [{ id: 't', text: '周报模板改版', status: 'active', next: '发用户确认', updatedAt: 1 }],
    recentlyDone: [{ id: 'd', text: '测试已补上', updatedAt: 1 }],
  };

  it('renders every section with message references and the not-authorization guidance', () => {
    const text = renderWorkingMemory(memory, { openTasks: [{ id: 'd-1', objective: '跑夜间回归', status: 'running' }] })!;
    expect(text.startsWith(WORKING_MEMORY_HEADING)).toBe(true);
    expect(text).toContain('not authorization');
    expect(text).toContain('- 先结论后细节 [supersedes: 旧格式] (message_id: u1)');
    expect(text).toContain('- 周五前改完周报模板 [when: 周五前]');
    expect(text).toContain('- user: 用户确认配色');
    expect(text).toContain('[running] 跑夜间回归 (task_id: d-1)');
    expect(text).toContain('- [active] 周报模板改版 → next: 发用户确认');
    expect(text).toContain('Recently completed');
  });

  it('drops trailing sections under budget but never the corrections, commitments or waiting', () => {
    const text = renderWorkingMemory(memory, {}, 500)!;
    expect(text).toContain('先结论后细节');
    expect(text).toContain('周五前改完周报模板');
    expect(text).toContain('用户确认配色');
    expect(text).not.toContain('Recently completed');
  });

  it('returns null for an empty ledger', () => {
    expect(renderWorkingMemory(emptyWorkingMemory())).toBeNull();
  });
});

describe('store', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wm-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips through the Bot Home file with CAS on revision', async () => {
    expect(await readBotWorkingMemory(root, 'bot-1')).toBeNull();
    const first = await writeBotWorkingMemory(
      root,
      'bot-1',
      { ...emptyWorkingMemory(), updatedAt: 5, commitments: [{ id: 'c', text: '承诺', updatedAt: 5 }] },
      0,
    );
    expect(first.revision).toBe(1);
    expect(workingMemoryPath(root, 'bot-1')).toBe(path.join(root, 'bots', 'bot-1', 'working-memory.json'));
    const stored = await readBotWorkingMemory(root, 'bot-1');
    expect(stored).toMatchObject({ revision: 1, commitments: [{ text: '承诺' }] });
    await expect(writeBotWorkingMemory(root, 'bot-1', emptyWorkingMemory(), 0)).rejects.toBeInstanceOf(WorkingMemoryRevisionConflict);
    await expect(writeBotWorkingMemory(root, 'bot-1', emptyWorkingMemory(), 1)).resolves.toMatchObject({ revision: 2 });
    expect((await fs.readdir(path.join(root, 'bots', 'bot-1'))).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('treats a corrupt or foreign file as no ledger', async () => {
    await fs.mkdir(path.join(root, 'bots', 'bot-2'), { recursive: true });
    await fs.writeFile(workingMemoryPath(root, 'bot-2'), '{not json', 'utf8');
    expect(await readBotWorkingMemory(root, 'bot-2')).toBeNull();
    expect(parseWorkingMemory({ version: 99, threads: [{ text: 'x' }] }).threads).toEqual([]);
    expect(parseWorkingMemory({ version: 1, revision: 2, threads: [{ id: 'a', text: '  多  空格 ', status: 'blocked' }] }))
      .toMatchObject({ revision: 2, threads: [{ id: 'a', text: '多 空格', status: 'blocked' }] });
  });
});

describe('helpers', () => {
  it('freshness compares the covered row against the latest completed reply', () => {
    expect(isWorkingMemoryFresh(null, 1)).toBe(false);
    expect(isWorkingMemoryFresh({ ...emptyWorkingMemory(), coveredThroughRowid: 9 }, 10)).toBe(false);
    expect(isWorkingMemoryFresh({ ...emptyWorkingMemory(), coveredThroughRowid: 10 }, 10)).toBe(true);
  });

  it('review view omits ids and timestamps', () => {
    const view = workingMemoryForReview({
      ...emptyWorkingMemory(),
      waiting: [{ id: 'w', text: '等确认', on: 'external', updatedAt: 3 }],
    });
    expect(view).toEqual({ threads: [], commitments: [], waiting: [{ text: '等确认', on: 'external' }], corrections: [], recentlyDone: [] });
  });

  it('refresh registry is a one-shot per session and the note wraps the rendered ledger', () => {
    const registry = createWorkingMemoryRefreshRegistry();
    expect(registry.isPending('s')).toBe(false);
    registry.markCompacted('s');
    expect(registry.isPending('s')).toBe(true);
    registry.consume('s');
    expect(registry.isPending('s')).toBe(false);
    const note = buildWorkingMemoryRefreshNote('BODY');
    expect(note).toContain('[Working memory refresh');
    expect(note).toContain('BODY');
    expect(note.trimEnd().endsWith("== End of working memory refresh; the user's new message follows ==")).toBe(true);
  });
});
