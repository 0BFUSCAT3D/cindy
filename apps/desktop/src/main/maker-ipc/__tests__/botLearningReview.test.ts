import { beforeEach, it, expect, vi } from 'vitest';
import { getDbClient } from '../../localDb/client/current.js';
const h = vi.hoisted(() => ({
  owner: 'owner',
  enabled: true,
  visible: true,
  meta: { turnCompleted: true } as Record<string, unknown>,
  model: vi.fn(),
  write: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  saveSkill: vi.fn(),
  refresh: vi.fn(),
  memories: [] as any[],
  skills: [] as any[],
  working: null as any,
  writeWorking: vi.fn(),
  /** 上一条完成回复的 rowid;当前回复是它 + 2(默认 5)。 */
  prevCompleted: 3 as number | null,
  /** 缺口回补查询(ORDER BY rowid ASC)返回的行。 */
  gapRows: [] as any[],
  /** 本轮取材查询返回的行;null = 默认一条用户消息。 */
  turnRows: null as any[] | null,
  /** 按账本 client_id 解析水位时返回的当前 rowid;null = 解析不到。 */
  floorRowid: null as number | null,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '/test-owner',
}));
vi.mock('../../localDb/client/current.js', () => {
  const db = {
    queryOne: async (sql: string) =>
      sql.includes('prev-completed')
        ? h.prevCompleted ? { id: 'prev', rowid: h.prevCompleted } : undefined
        : sql.includes('ledger-floor')
          ? h.floorRowid === null ? undefined : { rowid: h.floorRowid }
          : h.visible
          ? {
              botId: 'bot',
              capabilities: JSON.stringify({ memory: h.enabled }),
              // 当前回复:上一条完成回复 + 2(中间隔一条用户消息);默认 5。
              rowid: (h.prevCompleted ?? 0) + 2,
              meta: JSON.stringify(h.meta),
            }
          : undefined,
    query: vi.fn(async (sql: string) =>
      sql.includes('ORDER BY rowid ASC')
        ? h.gapRows
        : h.turnRows ?? [
            {
              id: 'user',
              role: 'user',
              content: JSON.stringify('Please always summarize the conclusion first.'),
              // 本轮的用户消息:紧跟在上一条完成回复之后。
              order: (h.prevCompleted ?? 0) + 1,
            },
          ],
    ),
  };
  return { getDbClient: () => db };
});
vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: async () => {},
  enqueueDurableWrite: async (_: unknown, run: () => unknown) => run(),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  patchMessageAgentMetaWithResult: async (_s: string, _r: string, patch: any) => {
    Object.assign(h.meta, patch);
    return {};
  },
}));
vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({
    makerMemory: {
      getStore: async () => ({ list: async () => h.memories, write: h.write, update: h.update }),
    },
  }),
}));
vi.mock('../../utility-model/oneShotCandidates.js', () => ({ requestUtilityText: h.model }));
vi.mock('../botLearningFeedback.js', () => ({ learningReceiptPublisher: () => h.publish }));
vi.mock('../botSkillStore.js', () => ({
  listBotSkills: async () => h.skills,
  readBotSkill: async (_r: string, _b: string, slug: string) =>
    h.skills.find((s) => s.slug === slug),
}));
vi.mock('../botSkillService.js', () => ({ saveBotSkillForSession: h.saveSkill }));
vi.mock('../botRuntimeEpochRefreshSignal.js', () => ({ requestBotRuntimeEpochRefresh: h.refresh }));
vi.mock('../botWorkingMemory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../botWorkingMemory.js')>();
  return {
    ...actual,
    readBotWorkingMemory: async () => h.working,
    writeBotWorkingMemory: h.writeWorking,
  };
});
import { reviewTeammateLearning } from '../botLearningReview.js';
const proposal = {
  type: 'feedback',
  name: 'conclusion_first',
  title: 'Conclusion first',
  description: 'Reporting preference',
  body: '**Why:** User requested this.\n**How to apply:** Lead with conclusions.',
  evidence: { messageId: 'user', quote: 'always summarize the conclusion first' },
};
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = 'owner';
  h.enabled = true;
  h.visible = true;
  h.meta = { turnCompleted: true };
  h.memories = [];
  h.skills = [];
  h.working = null;
  h.writeWorking.mockResolvedValue({ revision: 1 });
  h.write.mockResolvedValue({ ok: true });
  h.model.mockResolvedValue({
    ok: true,
    text: JSON.stringify({ memories: [proposal], skills: [] }),
  });
});
it('applies evidence-backed missing learning and publishes only to the frozen reply ID', async () => {
  await reviewTeammateLearning('session', 'original-reply');
  expect(h.write).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'conclusion_first', mode: 'create' }),
  );
  expect(h.publish).toHaveBeenCalledWith('original-reply', [
    expect.objectContaining({ kind: 'memory', title: 'Conclusion first' }),
  ]);
  await reviewTeammateLearning('session', 'original-reply');
  expect(h.model).toHaveBeenCalledOnce();
});
it('does not claim failed saves or apply memories when retention is disabled', async () => {
  h.write.mockRejectedValueOnce(new Error('disk full'));
  await reviewTeammateLearning('session', 'reply');
  expect(h.publish).not.toHaveBeenCalled();
  h.enabled = false;
  h.meta = { turnCompleted: true };
  h.write.mockClear();
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});
it('uses conditional updates and preserves edits made during the review', async () => {
  h.memories = [
    {
      filename: 'feedback_conclusion_first.md',
      slug: 'conclusion_first',
      body: 'old',
      frontmatter: { type: 'feedback', title: 'old', updatedAt: 'v1' },
    },
  ];
  h.update.mockRejectedValueOnce(new Error('version conflict'));
  await reviewTeammateLearning('session', 'reply');
  expect(h.update).toHaveBeenCalledWith('feedback_conclusion_first.md', 'v1', expect.anything());
  expect(h.write).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
});
it('drops model output after account switching or source reply removal', async () => {
  h.model.mockImplementationOnce(async () => {
    h.owner = 'new-owner';
    return { ok: true, text: JSON.stringify({ memories: [proposal], skills: [] }) };
  });
  await reviewTeammateLearning('session', 'reply');
  expect(h.write).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  h.owner = 'owner';
  h.meta = { turnCompleted: true };
  h.model.mockImplementationOnce(async () => {
    h.visible = false;
    return { ok: true, text: JSON.stringify({ memories: [proposal], skills: [] }) };
  });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});
it('empty and unsupported-evidence proposals produce no saves', async () => {
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [] }) });
  await reviewTeammateLearning('session', 'reply');
  expect(h.publish).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
  h.meta = { turnCompleted: true };
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [
        { ...proposal, evidence: { messageId: 'user', quote: 'not in the conversation' } },
      ],
      skills: [],
    }),
  });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.write).not.toHaveBeenCalled();
});

it('updates an existing Skill using its snapshot version and ignores disabled Skills', async () => {
  const skill = {
    slug: 'weekly-report',
    title: 'Weekly report',
    description: 'Reusable report format',
    body: 'Lead with the conclusion and then provide evidence.',
    evidence: proposal.evidence,
  };
  h.skills = [{ slug: skill.slug, name: skill.title, body: 'old format', updatedAt: 'v1' }];
  h.saveSkill.mockResolvedValue({
    ok: true,
    created: false,
    skill: { slug: skill.slug, name: skill.title },
  });
  h.model.mockResolvedValue({ ok: true, text: JSON.stringify({ memories: [], skills: [skill] }) });
  await reviewTeammateLearning('session', 'reply');
  expect(h.saveSkill).toHaveBeenCalledWith(
    expect.objectContaining({ slug: skill.slug, expectedUpdatedAt: 'v1' }),
  );
  expect(h.publish).toHaveBeenCalledWith('reply', [
    expect.objectContaining({ kind: 'skill', action: 'updated' }),
  ]);
  h.meta = { turnCompleted: true };
  h.skills[0].enabled = false;
  h.saveSkill.mockClear();
  await reviewTeammateLearning('session', 'reply2');
  expect(h.saveSkill).not.toHaveBeenCalled();
});

it('feeds the working memory to the review and writes an evidence-filtered ledger with CAS', async () => {
  h.working = { version: 1, revision: 4, coveredThroughRowid: 1, updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  h.model.mockResolvedValueOnce({
    ok: true,
    text: JSON.stringify({
      memories: [],
      skills: [],
      working: {
        commitments: [
          { text: 'Lead every report with the conclusion', evidence: { messageId: 'user', quote: 'summarize the conclusion first' } },
          { text: 'Invented promise', evidence: { messageId: 'user', quote: 'not in the conversation' } },
        ],
      },
    }),
  });
  await reviewTeammateLearning('session', 'reply');
  const input = JSON.parse(h.model.mock.calls[0]![1] as string);
  expect(input.workingMemory).toEqual({ threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] });
  // 本轮取材从上一条完成回复(3)接起;旧账本没有 client_id,存下的 rowid(1)不作数,缺口从对话开头(0)
  // 按升序分批回补;都不取 /clear 之前的消息。
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  const recent = query.mock.calls.slice(-2);
  expect(recent.map((call) => call[1])).toEqual([
    ['session', 5, 3, 'session'],
    ['session', 0, 3, 'session', 41],
  ]);
  expect(recent.every((call) => String(call[0]).includes('cleared_at'))).toBe(true);
  expect(h.writeWorking).toHaveBeenCalledWith(
    '/test-owner',
    'bot',
    expect.objectContaining({
      coveredThroughRowid: 5,
      // 水位同时记下当前回复的 client_id,作为瘦身重排后仍然可靠的持久判据。
      coveredThroughMessageId: 'reply',
      commitments: [expect.objectContaining({ text: 'Lead every report with the conclusion', messageId: 'user' })],
    }),
    4,
  );
  // 没有 working 字段的旧格式输出:账本不动。
  h.meta = { turnCompleted: true };
  h.writeWorking.mockClear();
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [] }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.writeWorking).not.toHaveBeenCalled();
});

it('advances the ledger watermark only through the contiguous backfilled prefix while a gap is still being caught up', async () => {
  const ledger = { version: 1, revision: 4, coveredThroughRowid: 1, updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  const gap = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ id: `g${from + i}`, role: 'assistant', content: JSON.stringify(`gap ${from + i}`), order: from + i }));
  h.working = { ...ledger };
  h.prevCompleted = 100;
  // 缺口 (1,100] 里有 41 条,超过每批 40 条:只补前 40 条,水位停在第 40 条(rowid 41),不推进到当前回复。
  h.gapRows = gap(2, 42);
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  const input = JSON.parse(h.model.mock.calls.at(-1)![1] as string);
  expect(input.messages.filter((m: { id: string }) => m.id.startsWith('g')).map((m: { id: string }) => m.id)).toEqual(
    gap(2, 41).map((m) => m.id),
  );
  expect(input.messages.at(-1).id).toBe('user');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 41, coveredThroughMessageId: 'g41' }), 4);
  // 下一轮按 client_id 'g41' 解析回当前 rowid(41)接上,剩余一条补完:水位推进到当前回复(102)。
  h.meta = { turnCompleted: true };
  h.working = { ...ledger, coveredThroughRowid: 41, coveredThroughMessageId: 'g41' };
  h.floorRowid = 41;
  h.gapRows = gap(42, 42);
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 102, coveredThroughMessageId: 'reply2' }), 4);
  h.prevCompleted = 3;
  h.gapRows = [];
  h.floorRowid = null;
});

it('resolves the ledger floor by client_id so a VACUUM-renumbered rowid cannot fake freshness, and starts a brand-new ledger from the beginning', async () => {
  const query = (getDbClient() as unknown as { query: ReturnType<typeof vi.fn> }).query;
  // 瘦身后 rowid 重排:账本存的 500 已经没有意义,按 client_id 解析回当前的 1 接上,写回当前库的水位(5)而不是保留 500。
  h.working = { version: 1, revision: 4, coveredThroughRowid: 500, coveredThroughMessageId: 'old-reply', updatedAt: 0, threads: [], commitments: [], waiting: [], corrections: [], recentlyDone: [] };
  h.floorRowid = 1;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 1, 3, 'session', 41]);
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 5, coveredThroughMessageId: 'reply' }), 4);
  // 有 client_id 但解析不到(水位消息已被删 / 撤回):同样不信存下的 500,从对话开头回补。
  h.meta = { turnCompleted: true };
  h.floorRowid = null;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply-gone');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 0, 3, 'session', 41]);
  // 没有账本:从对话开头起算,整段历史按缺口分批回补,而不是从上一条完成回复直接跳过去。
  h.meta = { turnCompleted: true };
  h.working = null;
  h.floorRowid = null;
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply2');
  expect(query.mock.calls.at(-1)![1]).toEqual(['session', 0, 3, 'session', 41]);
});

it('does not advance the watermark past the previous completed reply when the current turn itself was truncated', async () => {
  // 本轮取材取满 80 条 = 可能被 LIMIT 截断:水位停在上一条完成回复(3),留给下一次的缺口回补。
  h.working = null;
  h.turnRows = [
    { id: 'user', role: 'user', content: JSON.stringify('Please always summarize the conclusion first.'), order: 4 },
    ...Array.from({ length: 79 }, (_, i) => ({ id: `t${i}`, role: 'tool_result', content: JSON.stringify(`result ${i}`), order: 4 + i })),
  ];
  h.model.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ memories: [], skills: [], working: { commitments: [] } }) });
  await reviewTeammateLearning('session', 'reply');
  expect(h.writeWorking).toHaveBeenLastCalledWith('/test-owner', 'bot', expect.objectContaining({ coveredThroughRowid: 3, coveredThroughMessageId: 'prev' }), 0);
  h.turnRows = null;
});
