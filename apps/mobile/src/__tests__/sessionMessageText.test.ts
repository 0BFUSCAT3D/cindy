import { describe, expect, it } from 'vitest';
import { formatQuoteForSend } from '@cindy/maker-shared/chat-quotes';
import {
  compactSessionMessageLabel,
  mobileSessionMessageDisplayText,
  sentSessionMessageChipLabel,
  splitAnchoredSessionMessageLinks,
} from '@/session/sessionMessageText';
import type { RemoteMessage } from '@/session/types';

function message(input: Partial<RemoteMessage>): RemoteMessage {
  return { id: 'm', role: 'user', content: '', createdAt: '2026-07-23T00:00:00Z', ...input } as RemoteMessage;
}

describe('mobile session message labels', () => {
  it('uses visible prose and hides quote markers', () => {
    expect(mobileSessionMessageDisplayText(message({
      content: JSON.stringify({
        text: `${formatQuoteForSend({ text: 'source' })}\n\nanswer`,
        quotesEncoded: true,
      }),
    }))).toBe('answer');
  });

  it('does not stringify tool metadata', () => {
    expect(mobileSessionMessageDisplayText(message({ role: 'tool_use', content: { secret: true } }))).toBeNull();
  });

  it('shows anchored message labels as short plain text instead of raw Markdown', () => {
    const label = sentSessionMessageChipLabel(
      '**1. 深色·打开过程**：第一帧\n\n![深色-打开过程](cindy-media://blobs/0b12b71b6dcbf531eb89a2ed3b9ba7b1)',
    );
    expect(label).toBe('1. 深色·打开过程：第一帧 深色-打开过程');
    expect(sentSessionMessageChipLabel('上次我用的是 Claude Code 自带的 `SendUserFile` 发文件，工具返回了已送达'))
      .toBe('上次我用的是 Claude Code 自带的…');
    expect(Array.from(sentSessionMessageChipLabel('😀'.repeat(40)))).toHaveLength(24);
  });

  it('keeps composer and task-title labels at the original length and text', () => {
    const title = `任务 *标题* ${'长'.repeat(60)}`;
    expect(compactSessionMessageLabel(title)).toBe(title);
    expect(compactSessionMessageLabel('![](cindy-media://blobs/abc)')).toBe('![](cindy-media://blobs/abc)');
    expect(compactSessionMessageLabel('x'.repeat(300))).toHaveLength(240);
  });

  it('returns no label when the message has no readable text, never the raw Markdown source', () => {
    expect(sentSessionMessageChipLabel('![](cindy-media://blobs/abc)')).toBe('');
    expect(sentSessionMessageChipLabel('  \n ')).toBe('');
  });

  it('truncates by visible characters without splitting multi-codepoint emoji', () => {
    const flag = '🇨🇳';
    const family = '👨‍👩‍👧';
    const skin = '👍🏽';
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${flag}bb`)).toBe(`${'a'.repeat(22)}${flag}…`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${family}bb`)).toBe(`${'a'.repeat(22)}${family}…`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(22)}${skin}bb`)).toBe(`${'a'.repeat(22)}${skin}…`);
    expect(sentSessionMessageChipLabel(`${flag}${flag}`)).toBe(`${flag}${flag}`);
    expect(sentSessionMessageChipLabel(`${'a'.repeat(23)}e\u0301`)).toBe(`${'a'.repeat(23)}e\u0301`);
  });

  it('splits message anchors while preserving adjacent punctuation and whole-session links', () => {
    expect(splitAnchoredSessionMessageLinks(
      'See cindy://session/s-1?message=m-2, then cindy://session/s-3.',
    )).toEqual([
      { kind: 'text', text: 'See ' },
      {
        kind: 'message-link',
        url: 'cindy://session/s-1?message=m-2',
        sessionId: 's-1',
        messageClientId: 'm-2',
      },
      { kind: 'text', text: ', then cindy://session/s-3.' },
    ]);
  });
});
