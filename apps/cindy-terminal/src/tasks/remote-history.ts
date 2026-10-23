import { z } from 'zod';
import { XdtHelperToolRegistry } from '../../../../packages/lizi-mcps/src/lizi_xdtHelperToolRegistry.js';
import { registerListSessionsTool } from '../../../../packages/lizi-mcps/src/xdt-helper/list_sessions.js';
import { registerSearchChatHistoryTool } from '../../../../packages/lizi-mcps/src/xdt-helper/search_chat_history.js';
import { historyPayload } from '../../../../packages/lizi-mcps/src/xdt-helper/_history_devices.js';
import type { XdtHelperHistoryDeps } from '../../../../packages/lizi-mcps/src/xdt-helper/_history_types.js';

const request = z.object({
  sessionId: z.string().min(1), workdir: z.string().nullable(),
  fromMs: z.number().finite().nullable(), toMs: z.number().finite().nullable(),
  agentKind: z.enum(['cc', 'codex', 'pi']).nullable(),
  roles: z.array(z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'ask_user', 'plan_review', 'thinking'])).nullable(),
  includeRewound: z.boolean(), limit: z.number().int().min(1).max(1000),
  cursor: z.object({ id: z.string().min(1), createdAt: z.number().finite(), rowid: z.number().int().positive().optional() }).nullable(),
  order: z.enum(['asc', 'desc']), contentCharLimit: z.number().int().min(1).max(8000).nullable().optional(),
});

/** Device-link's released history contracts; reuse the same MCP query validators. */
export function createRemoteHistory(history: XdtHelperHistoryDeps, get: (id: string) => Promise<unknown>, guard: () => void) {
  return {
    async messages(value: unknown) {
      const input = request.parse(value);
      if (!await get(input.sessionId)) throw new Error('TASK_NOT_FOUND');
      guard();
      const result = await history.getMessages({ ...input, sessionIds: [input.sessionId] });
      guard();
      if (!result.ok) throw new Error(result.errorCode);
      const cap = input.contentCharLimit;
      return { ...result.page, items: result.page.items.map(item => {
        const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
        if (!cap || text.length <= cap || !['user', 'assistant'].includes(item.role)) return item;
        return { ...item, content: cap === 1 ? '…' : `…${text.slice(-(cap - 1))}`, agentMeta: { ...(item.agentMeta && typeof item.agentMeta === 'object' ? item.agentMeta : {}), remoteContentTruncated: true } };
      }), terminal: null };
    },
    async query(value: unknown) {
      const input = z.object({ tool: z.enum(['list_sessions', 'search_chat_history']), args: z.record(z.string(), z.unknown()) }).parse(value);
      if (input.args.device !== undefined && input.args.device !== 'local') throw new Error('INVALID_HISTORY_DEVICE');
      const registry = new XdtHelperToolRegistry();
      registerListSessionsTool(registry, { history });
      registerSearchChatHistoryTool(registry, { history });
      const result = historyPayload(await registry.call(input.tool, input.args));
      guard();
      return result;
    },
  };
}
