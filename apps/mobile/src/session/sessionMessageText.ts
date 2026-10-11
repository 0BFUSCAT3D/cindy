import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { parseMobileMarkdown, type MobileMarkdownInline } from '@/session/messageMarkdown';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  createSessionLinkPattern,
  parseSessionDeepLinkUrl,
  trimSessionLinkMatch,
} from '@/session/sessionLinks';
import type { RemoteMessage } from '@/session/types';

// 手机端消息锚点 chip 是正文里的行内 span,没法像桌面 pill 那样按宽度单行省略;
// 按字数截到约一行气泡宽,完整正文仍可点进目标消息查看。
const MESSAGE_LABEL_MAX_CHARS = 24;

/** Readable text only; never stringify tool/SDK metadata into a reference chip. */
export function mobileSessionMessageDisplayText(message: RemoteMessage): string | null {
  const normalized = normalizeRemoteMessages([message]).find((item) => (
    item.kind === 'user' || item.kind === 'assistant'
  ));
  if (!normalized) return null;
  let text = normalized.body.trim();
  if (normalized.kind === 'user' && normalized.quotesEncoded === true) {
    const segments = parseChatQuoteSegments(normalized.body);
    const hasQuote = segments.some((segment) => segment.kind === 'quote');
    if (hasQuote) text = joinChatQuoteTextSegments(segments).trim();
  }
  if (!text) {
    text = (normalized.attachments ?? []).map((item) => item.name).filter(Boolean).join(' · ');
  }
  return text || null;
}

function inlinesPlainText(inlines: readonly MobileMarkdownInline[]): string {
  return inlines.map((inline) => (inline.type === 'image' ? inline.alt : inline.text)).join('');
}

/** 被引用消息常是带图片 / 强调的 Markdown;chip 只显示读得懂的单行摘要,不露 `**`、`![](…)`。 */
function markdownPlainText(text: string): string {
  return parseMobileMarkdown(text).map((block) => {
    if (block.type === 'table') {
      return [block.header, ...block.rows.map((row) => row.cells)]
        .map((cells) => cells.map(inlinesPlainText).join(' ')).join(' ');
    }
    return 'inlines' in block ? inlinesPlainText(block.inlines) : block.text;
  }).join(' ');
}

export function compactSessionMessageLabel(text: string): string {
  const compact = markdownPlainText(text).replace(/\s+/g, ' ').trim() || text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length <= MESSAGE_LABEL_MAX_CHARS) return compact;
  return `${chars.slice(0, MESSAGE_LABEL_MAX_CHARS - 1).join('').trimEnd()}…`;
}

export type AnchoredSessionMessageTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'message-link'; url: string; sessionId: string; messageClientId: string };

/** Split only message-anchored session links; whole-session links stay in normal Markdown. */
export function splitAnchoredSessionMessageLinks(text: string): AnchoredSessionMessageTextPart[] {
  const parts: AnchoredSessionMessageTextPart[] = [];
  const pattern = createSessionLinkPattern();
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const url = trimSessionLinkMatch(match[0]);
    const target = parseSessionDeepLinkUrl(url);
    if (!target?.messageClientId) continue;
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push({
      kind: 'message-link',
      url,
      sessionId: target.sessionId,
      messageClientId: target.messageClientId,
    });
    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: 'text', text }];
}
