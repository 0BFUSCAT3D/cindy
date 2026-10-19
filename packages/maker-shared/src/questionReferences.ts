import { BARE_HTTP_URL_RE_SOURCE, clipBareHttpAutolinkText } from './urlTextBoundary.js';

export interface QuestionReferencePart {
  text: string;
  href?: string;
}

// Questions are plain text with optional evidence references, not full Markdown.
// Only identify candidates here: each client still verifies files using its
// existing session-aware resolver before making them clickable.
const FILE_REFERENCE = /^[^?#\n]+\.[A-Za-z0-9]{1,10}(?::[1-9]\d*(?::[1-9]\d*)?)?$/;
const OTHER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function isReference(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return true;
  const drivePath = /^[A-Za-z]:/.test(href) && (href[2] === '/' || href.charCodeAt(2) === 92);
  const withoutLine = href.replace(/:[1-9]\d*(?::[1-9]\d*)?$/, '');
  if (OTHER_SCHEME.test(withoutLine) && !drivePath && !href.startsWith('file://')) return false;
  if (href.startsWith('~/') || (href[0] === '~' && href.charCodeAt(1) === 92)) return false;
  return FILE_REFERENCE.test(href);
}

/** Preserve prose and answer keys; recognize labelled links, code and bare files/URLs. */
export function splitQuestionReferences(text: string): QuestionReferencePart[] {
  const parts: QuestionReferencePart[] = [];
  const append = (part: QuestionReferencePart) => {
    const previous = parts.at(-1);
    if (!part.href && previous && !previous.href) previous.text += part.text;
    else if (part.text) parts.push(part);
  };
  const token = new RegExp(
    [
      /\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s()]+(?:\([^\n()]*\)[^\s()]*)?))\)/.source,
      /\u0060([^\u0060\n]+)\u0060/.source,
      BARE_HTTP_URL_RE_SOURCE,
      /(?<![^\s(（【「"'，、;；])[^\s，。！？；：（）【】「」、()"'<>\[\]\u0060]+/.source,
    ].join('|'),
    'g',
  );
  let from = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index!;
    append({ text: text.slice(from, index) });
    const raw = match[0];
    if (match[1] !== undefined) {
      const href = (match[2] ?? match[3]).trim();
      append(isReference(href) ? { text: match[1], href } : { text: raw });
    } else if (match[4] !== undefined) {
      append(isReference(match[4]) ? { text: match[4], href: match[4] } : { text: raw });
    } else if (/^https?:\/\//i.test(raw)) {
      const href = clipBareHttpAutolinkText(raw, { prefix: text.slice(0, index) });
      append({ text: href, href });
      append({ text: raw.slice(href.length) });
    } else {
      const href = raw.replace(/[.,;!?]+$/, '');
      append(isReference(href) ? { text: href, href } : { text: href });
      append({ text: raw.slice(href.length) });
    }
    from = index + raw.length;
  }
  append({ text: text.slice(from) });
  return parts;
}
