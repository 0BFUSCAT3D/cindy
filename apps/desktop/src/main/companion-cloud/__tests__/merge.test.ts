import { describe, expect, it, vi } from 'vitest';
import { CINDY_DEFAULT_IDENTITY } from '../../../shared/botTemplatePreset.js';
import { isCindyCompanion, mergeCompanionsInto, renamedEntry } from '../merge.js';
import { fakeApi, fakeLocal } from './fakes.js';

const KEEP_ROOM = '10000000-0000-4000-8000-00000000000a';
const FROM_ROOM = '10000000-0000-4000-8000-00000000000b';
const keep = { id: 'actor-keep', externalId: 'cindy-default', name: 'Cindy', homeDeviceId: 'desk' };
const from = { id: 'actor-from', externalId: 'bot_laptop_cindy', name: 'Cindy', homeDeviceId: 'laptop', label: 'MacBook Pro' };

describe('telling the copies of Cindy apart', () => {
  it('goes by the preset, never by name', () => {
    expect(isCindyCompanion('cindy-default', null)).toBe(true);
    expect(isCindyCompanion('bot_1', { templateId: 'cindy' })).toBe(true);
    expect(isCindyCompanion('bot_1', { soul: CINDY_DEFAULT_IDENTITY })).toBe(true);
    expect(isCindyCompanion('bot_1', { name: 'Cindy', soul: 'my own' })).toBe(false);
  });

  it('names a second copy after where it came from', () => {
    expect(renamedEntry('user_tea.md', 'MacBook Pro')).toBe('user_tea-macbook-pro.md');
    expect(renamedEntry('brew', '工作')).toBe('brew-merged');
  });
});

describe('merging copies of Cindy', () => {
  function setup() {
    const imports: Array<{ room: string; messages: Array<{ sourceId: string; authorId: string; createdAt: string; content: unknown[] }> }> = [];
    const { api, calls } = fakeApi((route, method, data, actorId) => {
      if (route === '/preferences' && method === 'GET' && actorId === 'actor-from') return [
        { key: 'companion.profile.v1', value: { name: 'Cindy', soul: 'theirs' }, revision: 1 },
        { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: 'likes green tea' }, revision: 2 },
        { key: 'companion.memory.v1:user_new.md', value: { filename: 'user_new.md', content: 'only there' }, revision: 3 },
        { key: 'companion.memory.v1:user_same.md', value: { filename: 'user_same.md', content: 'same' }, revision: 4 },
        { key: 'companion.memory.v1:user_gone.md', value: null, revision: 5 },
        { key: 'companion.todo.v1:todo:1', value: { id: 'todo:1', title: 'x', history: [] }, revision: 6 },
      ];
      if (route.startsWith(`/conversations/${FROM_ROOM}/messages?`)) return [
        { id: 'm2', seq: '2', authorId: 'actor-from', createdAt: new Date(2_000).toISOString(), content: [{ type: 'text', text: 'hello back' }] },
        { id: 'm1', seq: '1', authorId: 'human', createdAt: new Date(1_000).toISOString(), content: [{ type: 'text', text: 'hi' }] },
      ];
      if (route.endsWith('/import')) { imports.push({ room: route.split('/')[2]!, messages: (data as { messages: never[] }).messages }); return {}; }
      if (method === 'PATCH') return {};
      throw new Error(`unexpected ${method} ${route}`);
    });
    const local = fakeLocal({ applyTodos: vi.fn(async () => undefined) });
    local.memories.set('user_tea.md', 'likes black tea');
    local.memories.set('user_same.md', 'same');
    const importHistory = vi.fn(async () => undefined);
    const run = () => mergeCompanionsInto({ api, host: local.host, keep, from: [from], humanActorId: 'human',
      roomOf: async (actor) => (actor.id === keep.id ? KEEP_ROOM : FROM_ROOM), importHistory, fence: { assertCurrent: () => undefined } });
    return { run, local, calls, imports, importHistory };
  }

  it('brings memories, todos and the conversation over, keeping a different same-name memory as a copy', async () => {
    const t = setup();
    const summary = await t.run();
    expect(t.local.memories.get('user_tea.md')).toBe('likes black tea');
    expect(t.local.memories.get('user_tea-macbook-pro.md')).toBe('likes green tea');
    expect(t.local.memories.get('user_new.md')).toBe('only there');
    expect(summary).toMatchObject({ merged: 1, messages: 2, memories: 2, renamed: ['user_tea-macbook-pro.md'] });
    expect(t.local.host.applyTodos).toHaveBeenCalledWith('cindy-default', [{ id: 'todo:1', title: 'x', history: [] }], [], expect.anything());
    // In message-time order, authored by the kept companion, with the original times.
    expect(t.imports[0]!.room).toBe(KEEP_ROOM);
    expect(t.imports[0]!.messages.map(m => [m.authorId, m.createdAt])).toEqual([['human', new Date(1_000).toISOString()], ['actor-keep', new Date(2_000).toISOString()]]);
    expect(t.calls.find(call => call.method === 'PATCH')).toMatchObject({ route: '/actors/actor-from', data: { disabled: true } });
    expect(t.importHistory).toHaveBeenCalledOnce();
  });

  it('can run again without duplicating anything', async () => {
    const t = setup();
    await t.run();
    const second = await t.run();
    expect(second.memories).toBe(0);
    expect(second.renamed).toEqual([]);
    // The same batch: the server dedupes by operation and source id.
    expect(t.imports[1]!.messages.map(m => m.sourceId)).toEqual(t.imports[0]!.messages.map(m => m.sourceId));
  });
});
