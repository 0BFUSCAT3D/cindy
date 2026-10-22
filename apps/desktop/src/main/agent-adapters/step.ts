import type { AgentAdapter } from '@cindy/maker-core/agent-adapters';
import { NativeAgentError, type NativeRpcConnection } from './acp.js';
import { boundedText as text, createEventSession, record } from './eventSession.js';

/** Step Code's official JSONL RPC; a prompt ack is not a completed Agent run. */
export async function connectStep(
  rpc: NativeRpcConnection,
  request: Parameters<AgentAdapter['start']>[0],
) {
  let failed = false,
    sawOutput = false,
    lastStopReason = '';
  let accepted: Promise<unknown> = Promise.resolve();
  const controller = createEventSession(rpc, request, {
    async send(message) {
      failed = false;
      sawOutput = false;
      lastStopReason = '';
      accepted = rpc.request('prompt', { message });
      await accepted;
      // Native control commands can finish synchronously without an Agent run.
      if (message.trimStart().startsWith('/')) {
        const state = record(await rpc.request('get_state', {}));
        if (
          state?.isStreaming === false &&
          state.isCompacting === false &&
          state.pendingMessageCount === 0
        )
          controller.finish();
      }
    },
    async stop() {
      const pending = accepted;
      await pending;
      if (accepted === pending && controller.running) await rpc.request('abort', {});
    },
  });
  rpc.onMessage = (frame) => {
    const event = record(frame.params);
    if (!event) return;
    if (frame.method === 'extension_ui_request') {
      const id = text(event.id, 200);
      if (!id) return;
      const method = event.method;
      if (method === 'confirm' || method === 'select') {
        const options =
          method === 'confirm'
            ? [
                { id: 'yes', label: 'Yes', labelKey: 'yes' as const, kind: 'allow_once' as const },
                { id: 'no', label: 'No', labelKey: 'no' as const, kind: 'reject_once' as const },
              ]
            : (Array.isArray(event.options) ? event.options : [])
                .slice(0, 16)
                .filter(
                  (value): value is string => typeof value === 'string' && value.length <= 1000,
                )
                .map((value, index) => ({ id: String(index), label: value }));
        controller.permission(
          id,
          [text(event.title, 500), text(event.message, 500)].filter(Boolean).join('\n'),
          options,
          (value) =>
            rpc.write({
              type: 'extension_ui_response',
              id,
              ...(value === null
                ? { cancelled: true }
                : method === 'confirm'
                  ? { confirmed: value === 'yes' }
                  : { value: options.find((o) => o.id === value)?.label }),
            }),
        );
      } else if (method === 'input' || method === 'editor') {
        // No free-form native input contract in the current adapter UI.
        rpc.write({ type: 'extension_ui_response', id, cancelled: true });
        controller.finish(new NativeAgentError('protocol-error'));
        void rpc.close();
      }
      return;
    }
    if (!controller.running) return;
    if (frame.method === 'message_update') {
      const delta = record(event.assistantMessageEvent);
      if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') {
        const value = text(delta.delta);
        sawOutput ||= !!value.trim();
        controller.emit({
          type: 'text',
          data: { text: value, thought: delta.type === 'thinking_delta' },
        });
      }
    } else if (frame.method === 'message_end') {
      const message = record(event.message);
      if (message?.role === 'assistant') {
        lastStopReason = text(message.stopReason, 30);
        failed = lastStopReason === 'error';
      }
    } else if (['tool_execution_start', 'tool_execution_end'].includes(String(frame.method))) {
      sawOutput = true;
      controller.emit({
        type: 'tool',
        data: {
          id: text(event.toolCallId, 160),
          title: text(event.toolName, 500),
          status:
            frame.method === 'tool_execution_start'
              ? 'in_progress'
              : event.isError
                ? 'failed'
                : 'completed',
          kind: ['bash', 'powershell'].includes(String(event.toolName)) ? 'execute' : 'other',
        },
      });
    } else if (frame.method === 'agent_settled') {
      controller.finish(
        lastStopReason === 'aborted' && !controller.cancelled
          ? new NativeAgentError('unexpected-cancellation')
          : !controller.cancelled && (failed || !sawOutput)
            ? new NativeAgentError('protocol-error')
            : undefined,
      );
    }
  };
  const state = record(await rpc.request('get_state', {}));
  if (controller.closed) throw new NativeAgentError('closed');
  if (typeof state?.isStreaming !== 'boolean') throw new NativeAgentError('protocol-error');
  return controller.session;
}
