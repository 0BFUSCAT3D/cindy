/** 远程事件落库和广播前还原文件引用；不改 Agent 的原生会话或执行权限。 */
import { pathToFileURL } from 'node:url';

import type { AgentEvent } from '@cindy/maker-core';

import type { ExecutorWorkspace } from '../executor/workspace';

const URL_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s\x60"'<>()[\]{}]+/gi;
const TEXT_BOUNDARIES = new Set(['tool_use', 'tool_result', 'tool_result_full', 'interaction_request', 'done', 'error', 'compact_boundary']);
const IDENTITY_FIELDS = new Set(['id', 'toolUseId', 'toolUseIds', 'agentMessageId', 'taskId', 'parentToolUseId', 'turnId', 'requestId', 'blockId', 'sessionId', 'sdkSessionId', 'toolName', 'lastToolName', 'model', 'providerId']);

function localFileUrl(value: string, workspace: ExecutorWorkspace): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      // 不能用本机平台的 fileURLToPath 解析另一台电脑的 Windows/POSIX URL。
      const remote = url.hostname
        ? '//' + url.hostname + decodeURIComponent(url.pathname)
        : decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:[\\/])/, '');
      const local = workspace.mapAlias(remote);
      if (local === remote) return value;
      const result = pathToFileURL(local);
      result.search = url.search;
      result.hash = url.hash;
      return result.href;
    }
    if (url.protocol === 'xdt-file:' || url.protocol === 'xdt-audio:') {
      const remote = url.searchParams.get('path');
      if (!remote) return value;
      const local = workspace.mapAlias(remote);
      if (local === remote) return value;
      url.searchParams.set('path', local);
      return url.href;
    }
  } catch { /* 普通文本和无法解析的 URL 保持既有行为。 */ }
  return value;
}

function localText(value: string, workspace: ExecutorWorkspace): string {
  // 先处理 JSON 字符串，保留 Windows 转义、正文格式和非字符串字节。
  if (/^\s*[{["]/.test(value)) {
    try {
      JSON.parse(value);
      return value.replace(/"(?:\\[\s\S]|[^"\\])*"/g, (literal) => {
        const decoded = JSON.parse(literal) as string;
        const local = localText(decoded, workspace);
        return local === decoded ? literal : JSON.stringify(local);
      });
    } catch { /* 非 JSON 按文件引用投影。 */ }
  }
  // Markdown 的代码引用和尖括号文件链接允许空格，需按完整路径还原。
  value = value.replace(/\x60([^\x60\r\n]+)\x60|<([^<>\r\n]+)>/g, (literal, code: string | undefined, angle: string | undefined) => {
    const remote = code ?? angle!;
    const local = workspace.mapAlias(remote);
    return local === remote ? literal : code !== undefined ? '\x60' + local + '\x60' : '<' + local + '>';
  });
  // URL 单独解析；HTTP 与媒体仓标识不得被普通路径替换改写。
  const parts: string[] = [];
  let end = 0;
  for (const match of value.matchAll(URL_TEXT)) {
    parts.push(workspace.mapTextFromAgent(value.slice(end, match.index)), localFileUrl(match[0], workspace));
    end = match.index! + match[0].length;
  }
  parts.push(workspace.mapTextFromAgent(value.slice(end)));
  return parts.join('');
}

function localValue(value: unknown, workspace: ExecutorWorkspace): unknown {
  if (typeof value === 'string') return localText(value, workspace);
  if (Array.isArray(value)) return value.map((item) => localValue(item, workspace));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY_FIELDS.has(key) ? item : localValue(item, workspace)]));
}

/** 只暂存末尾未闭合的路径，避免地址被多个 delta 切开后漏掉映射。 */
function pendingPathIndex(text: string, workspace: ExecutorWorkspace): number {
  let pending = text.length;
  const prefixes = workspace.agentPathPrefixes().flatMap((prefix) => {
    const forward = prefix.replace(/\\/g, '/');
    const backward = forward.replace(/\//g, '\\');
    return [forward, backward, backward.replace(/\\/g, '\\\\')];
  });
  if (!prefixes.length) return pending;
  // 完整 URL 出现前保留 scheme，才能在后续 delta 中判断文件 URL 或外部 URL。
  prefixes.push('file://', 'xdt-file://', 'xdt-audio://', 'http://', 'https://', 'cindy-media://');
  for (const prefix of prefixes) {
    const insensitive = /^[A-Za-z]:|^[a-z-]+:\/\//i.test(prefix);
    const source = insensitive ? text.toLowerCase() : text;
    const target = insensitive ? prefix.toLowerCase() : prefix;
    let start = -1;
    while ((start = source.indexOf(target[0], start + 1)) >= 0) {
      if (start && /[A-Za-z0-9_]/.test(text[start - 1])) continue;
      const tail = source.slice(start);
      const quote = text[start - 1];
      const closing = quote === '<' ? '>' : /["'\x60]/.test(quote ?? '') ? quote : undefined;
      if (target.startsWith(tail)) {
        pending = Math.min(pending, closing ? start - 1 : start);
        continue;
      }
      if (!tail.startsWith(target)) continue;
      if (!prefix.includes('://') && !/^[\\/]/.test(tail.slice(target.length))) continue;
      const suffix = text.slice(start + target.length);
      const ended = closing ? suffix.includes(closing) : prefix.includes('://')
        ? /[\s\x60"'<>()[\]{}]/.test(suffix) : /[\s\x60"'<>()[\]{};|&]/.test(suffix);
      if (!ended) {
        pending = Math.min(pending, closing ? start - 1 : start);
      }
    }
  }
  // 引号可能独占一个 delta；保留开引号，下一段路径才能按完整引用(含空格)解析。
  const trailing = text.at(-1);
  if (pending === text.length && trailing && /["'\x60<]/.test(trailing)
    && (trailing === '<' || text.split(trailing).length % 2 === 0)) pending = text.length - 1;
  return pending;
}

/** 保留原事件身份和增量/全文语义；仅把数据中的已知虚拟文件引用还原。 */
export class RemoteEventProjection {
  private pending: AgentEvent | null = null;

  constructor(private readonly workspace: ExecutorWorkspace) {}

  flush(): AgentEvent[] {
    if (!this.pending) return [];
    const event = this.pending;
    this.pending = null;
    return [{ ...event, data: localValue(event.data, this.workspace) }];
  }

  project(event: AgentEvent): AgentEvent[] {
    const data = event.data as { text?: unknown; isFinal?: boolean; isFullText?: boolean; agentMessageId?: string } | null;
    // 独立提示有自己的持久行，不能截断正在流式传输的正文路径。
    if (event.type === 'text' && event.standaloneText) {
      return [{ ...event, data: localValue(event.data, this.workspace) }];
    }
    if (event.type === 'text' && typeof data?.text === 'string' && !data.isFinal && !data.isFullText && !event.standaloneText) {
      const output: AgentEvent[] = [];
      if (this.pending) {
        const previous = this.pending.data as typeof data;
        if (this.pending.source !== event.source || this.pending.turnScope !== event.turnScope
          || previous?.agentMessageId !== data.agentMessageId) output.push(...this.flush());
      }
      const raw = (this.pending?.data as typeof data)?.text;
      const text = (typeof raw === 'string' ? raw : '') + data.text;
      const boundary = pendingPathIndex(text, this.workspace);
      this.pending = boundary < text.length ? { ...event, data: { ...data, text: text.slice(boundary) } } : null;
      if (boundary) output.push({ ...event, data: { ...data, text: localText(text.slice(0, boundary), this.workspace) } });
      return output;
    }
    const output = event.type === 'text' || (event.turnScope !== 'background' && TEXT_BOUNDARIES.has(event.type))
      ? this.flush() : [];
    // agentMeta、session/tool id 和权限回执不经过递归文本改写。
    output.push({ ...event, data: event.type === 'interaction_request' ? event.data : localValue(event.data, this.workspace) });
    return output;
  }
}
