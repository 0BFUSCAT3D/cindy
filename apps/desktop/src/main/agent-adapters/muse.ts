import { randomBytes } from 'node:crypto';
import type { AgentAdapter } from '@cindy/maker-core/agent-adapters';
import { NativeAgentError, type NativeRpcConnection } from './acp.js';
import { boundedText as text, createEventSession, record } from './eventSession.js';

/** MSP command IDs must be UUIDv7, independently of JSON-RPC request IDs. */
function commandId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

/** Muse's official MSP v1. Submission acknowledgements never complete a turn. */
export async function connectMuse(
  rpc: NativeRpcConnection,
  request: Parameters<AgentAdapter['start']>[0],
  root: string,
) {
  let sessionId = '',
    turnId = '',
    submissionId = '';
  let accepted: Promise<unknown> = Promise.resolve();
  const items = new Map<string, { kind: string; lengths: Map<string, number> }>();
  const approvalStages = new Map<string, { key: string; index: number; title: string }>();
  const seenApprovals = new Set<string>();
  const controller = createEventSession(rpc, request, {
    async send(message) {
      turnId = '';
      submissionId = commandId();
      items.clear();
      approvalStages.clear();
      seenApprovals.clear();
      accepted = rpc.request('turn/start', {
        sessionId,
        commandId: submissionId,
        input: [{ type: 'text', text: message }],
      });
      const result = record(await accepted);
      if (
        result?.status !== 'accepted' ||
        result.commandId !== submissionId ||
        result.disposition !== 'started' ||
        !text(result.turnId, 160) ||
        (turnId && turnId !== result.turnId)
      ) {
        await rpc.close();
        throw new NativeAgentError('protocol-error');
      }
      turnId = result.turnId as string;
    },
    async stop() {
      const pending = accepted,
        submission = submissionId;
      await pending;
      if (submission === submissionId && controller.running && turnId) await cancelTurn(turnId);
    },
  });
  const cancelTurn = async (target: string) => {
    await rpc.request('turn/cancel', { sessionId, commandId: commandId(), turnId: target });
  };
  const fail = () => {
    controller.finish(new NativeAgentError('protocol-error'));
    void rpc.close();
  };
  const emitText = (value: unknown, thought: boolean) => {
    if (typeof value !== 'string') return;
    for (let offset = 0; offset < value.length; offset += 16_384)
      controller.emit({
        type: 'text',
        data: { text: value.slice(offset, offset + 16_384), thought },
      });
  };
  rpc.onMessage = (frame) => {
    const event = record(frame.params);
    const matches = !!sessionId && event?.sessionId === sessionId;
    if (frame.id !== undefined) {
      // MSP requests acknowledge delivery; decisions use approval/decide separately.
      rpc.write(
        frame.method === 'approval/request' && matches
          ? { id: frame.id, result: {} }
          : { id: frame.id, error: { code: -32601, message: 'Client method not supported' } },
      );
    }
    if (!matches || !event || !controller.running) return;
    if (frame.method === 'turn/started') {
      if (event.commandId === submissionId && text(event.turnId, 160))
        turnId = event.turnId as string;
      return;
    }
    if (frame.method === 'item/delta') {
      const item = items.get(text(event.itemId, 160));
      const field = text(event.field, 80);
      if (
        !item ||
        typeof event.delta !== 'string' ||
        (!(item.kind === 'agentMessage' && field === 'text') &&
          !(item.kind === 'reasoning' && /^summary\.\d+$/.test(field)))
      )
        return;
      item.lengths.set(field, (item.lengths.get(field) ?? 0) + event.delta.length);
      emitText(event.delta, item.kind === 'reasoning');
      return;
    }
    const item = record(event.item);
    if (['item/started', 'item/updated', 'item/completed'].includes(String(frame.method))) {
      if (!turnId || item?.turnId !== turnId) return;
      const id = text(item.itemId, 160),
        kind = text(item.kind, 80);
      if (!id || !['agentMessage', 'reasoning', 'toolCall'].includes(kind)) return;
      if (!items.has(id)) {
        if (items.size >= 4096) {
          fail();
          return;
        }
        items.set(id, { kind, lengths: new Map() });
      }
      const state = items.get(id)!;
      if (state.kind !== kind) {
        fail();
        return;
      }
      if (kind === 'toolCall') {
        controller.emit({
          type: 'tool',
          data: {
            id,
            title: text(item.toolName, 500),
            kind: 'other',
            status:
              frame.method === 'item/completed'
                ? ['failed', 'rejected', 'cancelled'].includes(String(item.status).toLowerCase())
                  ? 'failed'
                  : 'completed'
                : 'in_progress',
          },
        });
      } else {
        const fields: [string, unknown][] = [['text', item.text]];
        if (kind === 'reasoning' && Array.isArray(item.summary))
          fields.push(
            ...item.summary.map((part, index): [string, unknown] => ['summary.' + index, part]),
          );
        for (const [field, value] of fields) {
          if (typeof value !== 'string') continue;
          const previous = state.lengths.get(field) ?? 0;
          // Full snapshots follow deltas: append only the unobserved suffix.
          if (value.length > previous) emitText(value.slice(previous), kind === 'reasoning');
          state.lengths.set(field, Math.max(previous, value.length));
        }
      }
      return;
    }
    // approval/updated deliberately omits turnId; only a known current-turn
    // approval can establish its ownership. A foreign explicit turnId still fails.
    const knownUpdate =
      frame.method === 'approval/updated' &&
      event.turnId === undefined &&
      approvalStages.has(text(event.approvalId, 160));
    if (!turnId || (event.turnId !== turnId && !knownUpdate)) return;
    if (
      ['approval/request', 'approval/requested', 'approval/updated'].includes(String(frame.method))
    ) {
      const approvalId = text(event.approvalId, 160),
        requirement = record(event.currentRequirementId);
      if (
        !approvalId ||
        requirement?.approvalId !== approvalId ||
        !Number.isSafeInteger(requirement.sourceIndex) ||
        Number(requirement.sourceIndex) < 0
      ) {
        fail();
        return;
      }
      const key = approvalId + ':' + requirement.sourceIndex;
      const previous = approvalStages.get(approvalId);
      if (frame.method === 'approval/updated' && !previous) return;
      if (previous && Number(requirement.sourceIndex) < previous.index) return;
      if (seenApprovals.has(key) && frame.method !== 'approval/updated') return;
      if (seenApprovals.size >= 4096) {
        fail();
        return;
      }
      seenApprovals.add(key);
      if (previous) controller.clearPermission(previous.key);
      const title =
        text(event.toolName, 1000) ||
        text(record(event.subject)?.toolName, 1000) ||
        previous?.title ||
        '';
      approvalStages.set(approvalId, { key, index: Number(requirement.sourceIndex), title });
      const choices = (Array.isArray(event.availableChoices) ? event.availableChoices : [])
        .slice(0, 16)
        .flatMap((raw) => {
          const choice = record(raw);
          if (
            !choice ||
            typeof choice.choiceId !== 'string' ||
            choice.choiceId.length > 160 ||
            !choice.choiceId ||
            typeof choice.label !== 'string'
          )
            return [];
          return [
            {
              id: choice.choiceId,
              label: text(choice.label, 250),
              kind:
                choice.decision === 'approved'
                  ? ('allow_once' as const)
                  : choice.decision === 'approvedForSession'
                    ? ('allow_always' as const)
                    : ['abort', 'denied', 'timedOut'].includes(String(choice.decision))
                      ? ('reject_once' as const)
                      : undefined,
            },
          ];
        });
      const target = turnId;
      controller.permission(key, title, choices, async (value) => {
        const choiceId = value ?? choices.find((choice) => choice.kind === 'reject_once')?.id;
        if (!choiceId) {
          await cancelTurn(target);
          return;
        }
        const result = record(
          await rpc.request('approval/decide', {
            sessionId,
            commandId: commandId(),
            approvalId,
            requirementId: { approvalId, sourceIndex: requirement.sourceIndex },
            choiceId,
          }),
        );
        if (result?.status !== 'accepted') throw new NativeAgentError('protocol-error');
      });
    } else if (frame.method === 'approval/resolved') {
      const stage = approvalStages.get(text(event.approvalId, 160));
      if (stage) controller.clearPermission(stage.key);
      approvalStages.delete(text(event.approvalId, 160));
    } else if (frame.method === 'turn/completed') {
      controller.finish(
        event.terminal === 'completed'
          ? undefined
          : event.terminal === 'cancelled'
            ? controller.cancelled
              ? undefined
              : new NativeAgentError('unexpected-cancellation')
            : new NativeAgentError('protocol-error'),
      );
    } else if (frame.method === 'userInput/request' || frame.method === 'userInput/requested') {
      // Free-text handoff has no contract in this adapter surface yet; never silently hang.
      fail();
    }
  };
  const initialized = record(
    await rpc.request('initialize', {
      clientInfo: { name: 'cindy', title: 'Cindy', version: '1' },
    }),
  );
  if (record(initialized?.schema)?.version !== 1) throw new NativeAgentError('protocol-error');
  rpc.write({ method: 'initialized' });
  const started = record(
    await rpc.request('session/start', { commandId: commandId(), workspaceRoot: root }),
  );
  sessionId = text(record(started?.session)?.sessionId, 160);
  if (controller.closed) throw new NativeAgentError('closed');
  if (!sessionId) throw new NativeAgentError('protocol-error');
  return controller.session;
}
