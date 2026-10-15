import { z } from 'zod';
import { McpUiHostContextSchema } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { McpAppsHost } from './host.js';
import type { McpAppDocument } from '../../shared/mcpApps.js';
import { MCP_APPS_MAX_BYTES, safeAppLink } from './protocol.js';

const id = z.string().min(1).max(256);
const request = z.discriminatedUnion('op', [
  z.object({ op: z.literal('open'), clientId: id, openId: id.optional(), context: McpUiHostContextSchema.default({}) }),
  z.object({ op: z.literal('cancel-open'), openId: id }),
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
/** Called only by the protocol's frame-verified channel, with Host-bound task and View IDs. */
export async function handleMcpAppFrameOperation(
  host: McpAppsHost, caller: string, sessionId: string, viewId: string, raw: unknown,
  openLink: (url: string) => Promise<void>,
): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MCP_APP_INVALID_REQUEST');
  const input = raw as Record<string, unknown>;
  if (input.op === 'open-link') {
    if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('MCP_APP_INVALID_LINK');
    const url = safeAppLink(input.url);
    // A returned poll event is not a grant: the card can be revoked before this POST.
    await host.assertViewAuthorized(caller, sessionId, viewId);
    await openLink(url);
    return {};
  }
  if (!['message', 'poll', 'link-result'].includes(String(input.op))) throw new Error('MCP_APP_INVALID_REQUEST');
  return handleMcpAppOperation(host, caller, sessionId, { ...input, viewId });
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
      const document = await host.open(caller, sessionId, input.clientId, input.context, input.openId);
      local?.supply(document, caller);
      return local ? { ...document, transport: 'sandbox' } : document;
    }
    case 'cancel-open':
      await host.cancelOpen(caller, sessionId, input.openId);
      return {};
    case 'message':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
      await host.dispatch(caller, sessionId, input.viewId, input.message);
      return {};
    case 'poll':
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
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
      if (local) throw new Error('MCP_APP_FRAME_REQUIRED');
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
