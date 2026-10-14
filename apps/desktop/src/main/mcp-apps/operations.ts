import { z } from 'zod';
import { McpUiHostContextSchema } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpAppsHost } from './host.js';
import type { McpAppDocument } from '../../shared/mcpApps.js';
import { MCP_APPS_MAX_BYTES, safeAppLink } from './protocol.js';

const id = z.string().min(1).max(256);
const request = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), clientId: id, context: McpUiHostContextSchema.default({}) }),
  z.object({ op: z.literal('message'), viewId: id, message: z.unknown() }),
  z.object({ op: z.literal('poll'), viewId: id, after: z.number().int().nonnegative().default(0) }),
  z.object({ op: z.literal('context'), viewId: id, context: McpUiHostContextSchema }),
  z.object({ op: z.literal('teardown'), viewId: id, alreadyNotified: z.boolean().default(false) }),
  z.object({
    op: z.literal('display-mode'),
    viewId: id,
    mode: z.enum(['inline', 'fullscreen', 'pip']),
  }),
  z.object({ op: z.literal('link-result'), viewId: id, linkId: id, success: z.boolean() }),
  z.object({ op: z.literal('mount-remote'), document: z.unknown() }),
  z.object({ op: z.literal('unmount-remote'), viewId: id }),
  z.object({ op: z.literal('open-link'), viewId: id, url: z.string().max(8192) }),
]);
interface LocalViewDeps {
  supply(document: McpAppDocument, caller: string): void;
  mount(document: unknown, caller: string): string;
  unmount(id: string, caller: string): void;
  assertCaller(id: string, caller: string): void;
  openLink(url: string): Promise<void>;
}
export async function handleMcpAppOperation(
  host: McpAppsHost,
  caller: string,
  sessionId: string,
  raw: unknown,
  local?: LocalViewDeps,
): Promise<unknown> {
  if (
    !id.safeParse(sessionId).success ||
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Buffer.byteLength(JSON.stringify(raw)) > MCP_APPS_MAX_BYTES
  )
    throw new Error('MCP_APP_INVALID_REQUEST');
  const parsed = request.safeParse(raw);
  if (!parsed.success) throw new Error('MCP_APP_INVALID_REQUEST');
  const input = parsed.data;
  switch (input.op) {
    case 'open': {
      const document = await host.open(caller, sessionId, input.clientId, input.context);
      local?.supply(document, caller);
      return document;
    }
    case 'message':
      await host.dispatch(caller, sessionId, input.viewId, input.message);
      return {};
    case 'poll':
      return await host.poll(caller, sessionId, input.viewId, input.after);
    case 'context':
      host.context(caller, sessionId, input.viewId, input.context);
      return {};
    case 'teardown':
      await host.teardown(caller, sessionId, input.viewId, input.alreadyNotified);
      return {};
    case 'display-mode':
      host.displayMode(caller, sessionId, input.viewId, input.mode);
      return {};
    case 'link-result':
      host.linkResult(caller, sessionId, input.viewId, input.linkId, input.success);
      return {};
    case 'mount-remote':
      if (local) return local.mount(input.document, caller);
      break;
    case 'unmount-remote':
      if (local) {
        local.unmount(input.viewId, caller);
        return {};
      }
      break;
    case 'open-link':
      if (local) {
        local.assertCaller(input.viewId, caller);
        await local.openLink(safeAppLink(input.url));
        return {};
      }
      break;
  }
  throw new Error('MCP_APP_INVALID_REQUEST');
}
