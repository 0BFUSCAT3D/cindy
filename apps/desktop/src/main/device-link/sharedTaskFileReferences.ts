import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { describeToolUse, createdPathsFromDescriptor } from '@cindy/maker-shared/tool-use-descriptor';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import { isToolResultFailureLike } from '@cindy/maker-shared/message-presentation';
import { extractPayloadToolResultFiles } from '@cindy/maker-shared/payload-summary';
import { extractCommandOutputPathCandidates } from '../../shared/commandOutputPaths.js';
import { getDbClient } from '../localDb/client/current.js';
import type { SharedTaskPeerCapture } from './sharedTaskDispatch.js';

const markdown = unified().use(remarkParse);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function decode(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/** Only explicit file references count; a substring in source, a patch or a log does not. */
function references(content: unknown, role: string, includeText: boolean): string[] {
  const body = record(content);
  if (role === 'tool_use') {
    const tool = parseMessageToolUse({ role, content });
    const descriptor = describeToolUse(tool.toolName, tool.input);
    if (descriptor.kind === 'command') return extractCommandOutputPathCandidates(descriptor.command);
    return createdPathsFromDescriptor(descriptor);
  }
  if (role === 'tool_result') {
    return extractPayloadToolResultFiles(typeof content === 'string' ? content : JSON.stringify(content)).map((file) => file.url);
  }
  const result: string[] = [];
  // Persisted attachments have passed the host's input-reference admission and
  // materialization. Never interpret a JSON-looking message string as attachments.
  for (const key of ['files', 'images']) {
    if (!Array.isArray(body?.[key])) continue;
    for (const attachment of body[key]) {
      const file = record(attachment);
      if (typeof file?.path === 'string') result.push(file.path);
      if (typeof file?.url === 'string') result.push(file.url);
    }
  }
  if (!includeText) return result;
  const text = typeof content === 'string' ? content : typeof body?.text === 'string' ? body.text : '';
  // Match the rendered links/file chips, not examples inside fenced source or
  // unused reference definitions. An AST also preserves spaces and parentheses.
  result.push(text);
  const tree = markdown.parse(text);
  const definitions = new Map<string, string>();
  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    if (node.type === 'link' || node.type === 'image') result.push(node.url);
    else if (node.type === 'inlineCode') result.push(node.value);
    else if (node.type === 'linkReference' || node.type === 'imageReference') {
      const url = definitions.get(node.identifier);
      if (url) result.push(url);
    }
  });
  return result;
}

function referencePath(reference: string, workingDir: string): string | null {
  let value = reference.trim();
  try {
    if (value.startsWith('xdt-file://') || value.startsWith('xdt-audio://')) {
      const url = new URL(value);
      // A remote file reference must never grant access to a coincident local path.
      if (url.searchParams.has('remoteHostId')) return null;
      value = url.searchParams.get('path') ?? (value.startsWith('xdt-file:///') ? decodeURIComponent(value.slice('xdt-file://'.length)) : '');
    } else if (value.startsWith('file://')) {
      value = fileURLToPath(value);
    } else {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
      // Markdown file links may carry a line locator. It is not part of the file.
      value = value.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L\d+)?)$/, '');
      // Raw local Markdown destinations/attachment paths preserve literal '%',
      // unlike file:// and query-based URLs, which were decoded above.
    }
    if (!value || value.includes('\0')) return null;
    if (!path.isAbsolute(value) && !/^(?:\.\.?)[\\/]/.test(value)) return null;
    return path.resolve(workingDir, value);
  } catch { return null; }
}

/** Read current host history, never the guest's payload or a stale authorization cache. */
export async function sharedTaskReferencesFile(
  requested: string, workingDir: string, capture: SharedTaskPeerCapture,
): Promise<boolean> {
  const name = path.basename(requested);
  const encodedName = encodeURIComponent(name);
  const needles = [name, encodedName, encodedName.replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16)), JSON.stringify(name).slice(1, -1)];
  let after = 0;
  while (capture.isCurrent()) {
    const rows = await getDbClient().query<{ rowid: number; role: string; content: string; agentMeta: string | null; toolUseId: string | null }>(
      `SELECT rowid, role, content, agent_meta AS agentMeta, tool_use_id AS toolUseId FROM messages
       WHERE session_id = ? AND rewind_at IS NULL AND rowid > ?
         AND role IN ('user', 'assistant', 'tool_use', 'tool_result')
         AND (instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)
       ORDER BY rowid LIMIT 64`,
      [capture.author.sessionId, after, ...needles],
    );
    if (!capture.isCurrent()) return false;
    for (const row of rows) {
      // Guest attribution is stamped by Main. Guest prose never grants access;
      // only the separately validated, host-materialized attachments are usable.
      const meta = row.agentMeta ? record(decode(row.agentMeta)) : null;
      if (row.role === 'user' && row.agentMeta && !meta) continue;
      const content = decode(row.content);
      if (!references(content, row.role, row.role !== 'user' || !meta?.sharedTaskAuthor).some((reference) => {
        const candidate = referencePath(reference, workingDir);
        return candidate !== null && path.relative(requested, candidate) === '';
      })) continue;
      if (row.role === 'tool_use') {
        // A queued/denied tool invocation is not delivery. Only completed output
        // records can expose generated file chips outside the workspace.
        const tool = parseMessageToolUse({ ...row, content });
        if (!tool.toolUseId) continue;
        const results = await getDbClient().query<{ content: string }>(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'tool_result'
           AND rewind_at IS NULL AND tool_use_id = ? AND rowid > ? ORDER BY rowid LIMIT 1`,
          [capture.author.sessionId, tool.toolUseId, row.rowid],
        );
        if (!capture.isCurrent()) return false;
        if (!results.length) continue;
        const result = decode(results[0].content);
        if (isToolResultFailureLike(describeToolUse(tool.toolName, tool.input), typeof result === 'string' ? result : JSON.stringify(result))) continue;
      }
      return true;
    }
    if (rows.length < 64) return false;
    const last = rows[rows.length - 1].rowid;
    if (last <= after) return false;
    after = last;
  }
  return false;
}
