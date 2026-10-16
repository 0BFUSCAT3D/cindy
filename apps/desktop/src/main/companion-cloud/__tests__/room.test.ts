import { describe, expect, it } from 'vitest';
import { readAllRoomMessages, transcriptPageOf } from '../room.js';
import type { CompanionTranscriptMessage } from '../../../shared/companionCloud.js';
import { fakeApi } from './fakes.js';

const message = (seq: number, createdAt: number, author = 'human') => ({
  id: `m${seq}`, seq: String(seq), authorId: author, createdAt: new Date(createdAt).toISOString(), content: [{ type: 'text', text: `t${seq}` }],
});

describe('reading the whole room', () => {
  it('pages through every message and orders by message time, not arrival', async () => {
    // Seq 101..200 arrived later but are older history (uploaded by a backfill).
    const room = [...Array.from({ length: 100 }, (_, i) => message(i + 1, 10_000 + i)),
      ...Array.from({ length: 100 }, (_, i) => message(i + 101, 1_000 + i, 'bot'))];
    const { api } = fakeApi((route) => {
      const before = /before=(\d+)/.exec(route)?.[1];
      const older = room.filter(m => !before || BigInt(m.seq) < BigInt(before)).reverse();
      return older.slice(0, 100);
    });
    const all = await readAllRoomMessages(api, 'room', 'bot');
    expect(all).toHaveLength(200);
    expect(all[0]!.text).toBe('t101');
    expect(all.at(-1)!.text).toBe('t100');
    expect(all[0]!.role).toBe('assistant');
  });
});

describe('transcript pages', () => {
  const at = (createdAt: number, n: number): CompanionTranscriptMessage => ({ id: `x${n}`, seq: String(n), role: 'user', text: `${n}`, createdAt });

  it('returns the latest page and a cursor for older messages, keeping equal times together', () => {
    // 102 messages; the 100-message boundary falls between two that share a time: both stay.
    const messages = Array.from({ length: 102 }, (_, i) => at(i === 2 ? 1 : i, i));
    const first = transcriptPageOf(messages);
    expect(first.messages).toHaveLength(101);
    expect(first.messages[0]!.text).toBe('1');
    expect(first.nextBefore).toBe('1');
    expect(transcriptPageOf(messages, 1).messages.map(m => m.text)).toEqual(['0']);
    const short = transcriptPageOf(Array.from({ length: 150 }, (_, i) => at(i + 1, i + 1)));
    expect(short.messages).toHaveLength(100);
    expect(short.nextBefore).toBe('51');
    expect(transcriptPageOf(Array.from({ length: 150 }, (_, i) => at(i + 1, i + 1)), 51).messages.map(m => m.text).at(-1)).toBe('50');
  });
});
