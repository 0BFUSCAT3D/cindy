import { describe, expect, it } from 'vitest';
import type { BotCollaborationMeta } from '../botCollaboration';
import { buildBotGroupTaskCard, parseBotGroupTaskCardView, readBotGroupTaskCard } from '../botGroupTask';

const meta: BotCollaborationMeta = {
  v: 1, role: 'delegation-request', delegationId: 'task-1', fromBotId: 'bot-a', fromBotName: 'LiZi',
  toBotId: null, toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-1', objective: 'Write the launch post',
};

describe('group task card (bot-group-chat.md §10)', () => {
  it('builds a card older clients read as one fallback line and new clients read back as the view', () => {
    const card = buildBotGroupTaskCard({ meta, state: 'started', title: 'Launch post' });
    expect(card).toMatchObject({ type: 'card', namespace: 'cindy.task', schemaRevision: 1, fallback: '[任务] Launch post · 进行中' });
    expect(readBotGroupTaskCard(card)).toEqual({ meta, state: 'started', title: 'Launch post' });
    expect(parseBotGroupTaskCardView(card.data)).toEqual({ meta, state: 'started', title: 'Launch post' });
  });

  it('keeps what a waiting task asks for, clipped, and never a tool argument block', () => {
    const summary = `1. Which audience?（Developers / Everyone）\n${'x'.repeat(500)}`;
    const card = buildBotGroupTaskCard({ meta, state: 'waiting', title: 'Launch post', summary });
    expect(card.data.summary!.length).toBeLessThanOrEqual(400);
    expect(card.fallback.startsWith('[任务] Launch post · 等你确认：1. Which audience?')).toBe(true);
    expect(readBotGroupTaskCard(card)?.summary).toBe(card.data.summary);
  });

  it.each([
    ['wrong namespace', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }), namespace: 'cindy.plan' }],
    ['future revision', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }), schemaRevision: 2 }],
    ['unknown state', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }), data: { meta, state: 'paused', title: 't' } }],
    ['result receipt instead of the anchor', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }), data: { meta: { ...meta, role: 'delegation-result' }, state: 'started', title: 't' } }],
    ['missing meta', { ...buildBotGroupTaskCard({ meta, state: 'started', title: 't' }), data: { state: 'started', title: 't' } }],
    ['not a card', { type: 'text', text: '[任务] t · 进行中' }],
  ])('rejects a malformed card (%s) so the message falls back to text', (_label, block) => {
    expect(readBotGroupTaskCard(block)).toBeNull();
  });

  it('rejects a view whose task anchor is not a delegation request', () => {
    expect(parseBotGroupTaskCardView({ meta: { ...meta, role: 'interjection' }, state: 'completed', title: 't' })).toBeNull();
    expect(parseBotGroupTaskCardView(null)).toBeNull();
  });
});
