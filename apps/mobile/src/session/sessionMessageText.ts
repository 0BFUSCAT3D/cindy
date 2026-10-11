import { joinChatQuoteTextSegments, parseChatQuoteSegments } from '@cindy/maker-shared/chat-quotes';
import { parseMobileMarkdown, type MobileMarkdownInline } from '@/session/messageMarkdown';
import { normalizeRemoteMessages } from '@/session/messageNormalize';
import {
  createSessionLinkPattern,
  parseSessionDeepLinkUrl,
  trimSessionLinkMatch,
} from '@/session/sessionLinks';
import type { RemoteMessage } from '@/session/types';

const MESSAGE_LABEL_MAX_CHARS = 240;
// 已发送气泡里的消息锚点 chip 是正文里的行内 span,没法像桌面 pill 那样按宽度单行省略;
// 按字数截到约一行气泡宽,完整正文仍可点进目标消息查看。
const SENT_MESSAGE_CHIP_MAX_CHARS = 24;

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

// 附着在前一个字符上的码点:组合符、ZWJ、变体选择符、肤色修饰、标签字符。
const CLUSTER_EXTEND = /^[\p{M}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]$/u;
const REGIONAL_INDICATOR = /^[\u{1F1E6}-\u{1F1FF}]$/u;

/**
 * 按用户看到的字符分组(Hermes 没有 Intl.Segmenter):覆盖 ZWJ 家庭 / 肤色 / 国旗 /
 * 组合附加符,截断时不把一个 emoji 拆成两半。
 */
function displayCharacters(text: string): string[] {
  const clusters: string[] = [];
  let joinNext = false;
  let regionalRun = 0;
  for (const codePoint of text) {
    const last = clusters.length - 1;
    const regional = REGIONAL_INDICATOR.test(codePoint);
    if (last >= 0 && (joinNext || CLUSTER_EXTEND.test(codePoint) || (regional && regionalRun % 2 === 1))) {
      clusters[last] += codePoint;
    } else {
      clusters.push(codePoint);
    }
    regionalRun = regional ? regionalRun + 1 : 0;
    joinNext = codePoint === '\u200D';
  }
  return clusters;
}

export function compactSessionMessageLabel(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MESSAGE_LABEL_MAX_CHARS) return compact;
  return `${compact.slice(0, MESSAGE_LABEL_MAX_CHARS - 1)}…`;
}

/**
 * 已发送消息里引用 chip 的可见摘要(仅渲染用,不进输入框 atom / 发送数据);
 * 没有可读文字(如只有无说明图片)时返回空串,由调用方给中性占位。
 */
export function sentSessionMessageChipLabel(text: string): string {
  const compact = markdownPlainText(text).replace(/\s+/g, ' ').trim();
  const chars = displayCharacters(compact);
  if (chars.length <= SENT_MESSAGE_CHIP_MAX_CHARS) return compact;
  return `${chars.slice(0, SENT_MESSAGE_CHIP_MAX_CHARS - 1).join('').trimEnd()}…`;
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
