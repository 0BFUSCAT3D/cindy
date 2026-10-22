import type {
  AgentAdapter,
  AgentAdapterEvent,
  AgentSession,
} from '@cindy/maker-core/agent-adapters';
import { NativeAgentError, type NativeRpcConnection } from './acp.js';

export const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export const boundedText = (value: unknown, max = 16_384): string =>
  typeof value === 'string' ? value.slice(0, max) : '';

type Choice = {
  id: string;
  label: string;
  labelKey?: 'yes' | 'no';
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
};

/** For native protocols that acknowledge submission before emitting the final turn event. */
export function createEventSession(
  rpc: NativeRpcConnection,
  request: Parameters<AgentAdapter['start']>[0],
  driver: { send(text: string): Promise<void>; stop(): Promise<void> },
) {
  let closed = false,
    sequence = 0;
  let terminalError: Error | undefined;
  let turn:
    { resolve(): void; reject(error: Error): void; done: boolean; cancelled: boolean } | undefined;
  const listeners = new Set<(event: AgentAdapterEvent) => void>();
  const permissions = new Map<
    string,
    {
      key: string;
      choices: Choice[];
      respond(value: string | null): Promise<void> | void;
    }
  >();
  const emit = (event: AgentAdapterEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* isolate observers */
      }
    }
  };
  const finish = (error?: Error) => {
    if (!turn || turn.done) return;
    turn.done = true;
    terminalError = error;
    permissions.clear();
    emit({ type: 'permissions.cleared' });
    if (error) turn.reject(error);
    else turn.resolve();
  };
  const clear = () => {
    for (const entry of permissions.values()) {
      try {
        void Promise.resolve(entry.respond(null)).catch(() => {});
      } catch {
        /* closed */
      }
    }
    permissions.clear();
    emit({ type: 'permissions.cleared' });
  };
  rpc.onClose = () => {
    closed = true;
    finish(new NativeAgentError('closed'));
    permissions.clear();
    emit({ type: 'permissions.cleared' });
    emit({ type: 'closed' });
  };
  const session: AgentSession = {
    instanceId: request.instanceId,
    runtimeNodeId: request.runtimeNodeId,
    onEvent(listener) {
      listeners.add(listener);
      if (closed) listener({ type: 'closed' });
      return () => listeners.delete(listener);
    },
    async send(input) {
      if (closed) throw new NativeAgentError('closed');
      if (turn) throw new NativeAgentError('busy');
      if (!input.text.trim() || input.text.length > 32_000)
        throw new NativeAgentError('protocol-error');
      terminalError = undefined;
      const completed = new Promise<void>((resolve, reject) => {
        turn = { resolve, reject, done: false, cancelled: false };
      });
      // The native terminal event may arrive before submission's response.
      void completed.catch(() => {});
      try {
        await driver.send(input.text);
        await completed;
      } catch (error) {
        // A terminal error may precede the ACK and close its transport. Preserve
        // the actual failure instead of replacing it with that late ACK's error.
        throw terminalError ?? error;
      } finally {
        clear();
        turn = undefined;
      }
    },
    async stop() {
      if (closed || !turn || turn.done || turn.cancelled) return;
      turn.cancelled = true;
      clear();
      await driver.stop();
    },
    async respondPermission(id, optionId) {
      const entry = permissions.get(id);
      const choice = entry?.choices.find((value) => value.id === optionId);
      if (closed || !turn || turn.done || !entry || (optionId !== null && !choice))
        throw new NativeAgentError('invalid-permission');
      permissions.delete(id);
      const owner = turn;
      if (
        turn &&
        (optionId === null || choice?.kind === 'reject_once' || choice?.kind === 'reject_always')
      )
        turn.cancelled = true;
      try {
        await entry.respond(optionId);
      } catch (error) {
        if (turn === owner) {
          finish(
            error instanceof NativeAgentError ? error : new NativeAgentError('protocol-error'),
          );
          await rpc.close();
        }
        throw error instanceof NativeAgentError ? error : new NativeAgentError('protocol-error');
      }
      emit({ type: 'permission.resolved', data: { id } });
    },
    async close() {
      clear();
      await rpc.close();
      listeners.clear();
    },
  };
  return {
    session,
    emit,
    finish,
    get closed() {
      return closed;
    },
    get running() {
      return !!turn && !turn.done;
    },
    get cancelled() {
      return turn?.cancelled ?? false;
    },
    permission(
      key: string,
      title: string,
      choices: Choice[],
      respond: (value: string | null) => Promise<void> | void,
    ) {
      if (!turn || turn.done || closed || permissions.size >= 16 || !choices.length) {
        try {
          void Promise.resolve(respond(null)).catch(() => {});
        } catch {
          /* closed */
        }
        return;
      }
      if ([...permissions.values()].some((entry) => entry.key === key)) return;
      const id = String(++sequence);
      permissions.set(id, { key, choices, respond });
      emit({ type: 'permission', data: { id, title: boundedText(title, 1000), options: choices } });
    },
    clearPermission(key: string) {
      for (const [id, entry] of permissions)
        if (entry.key === key) {
          permissions.delete(id);
          emit({ type: 'permission.resolved', data: { id } });
        }
    },
  };
}
