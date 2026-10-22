import { createHash, randomUUID } from 'node:crypto';
import type { AgentAdapterEvent, AgentSession } from '@cindy/maker-core/agent-adapters';
import type { AgentAdapterRuntime } from './runtime.js';
import { NativeAgentError } from './acp.js';

export class AdapterSessionError extends Error {
  constructor(
    readonly code:
      'disabled' | 'invalid-input' | 'unavailable' | 'not-found' | 'busy' | 'limit' | 'stale',
  ) {
    super(code);
  }
}
export interface AdapterWorkspace {
  id: string;
  label: string;
  root: string;
}
export interface AdapterPermission {
  id: string;
  title: string;
  // Canonical ACP semantics stay on the host; resource forms still use only id/label.
  options: {
    id: string;
    label: string;
    /** Host-created confirmation choices; localized by the viewing resource, not native labels. */
    labelKey?: 'yes' | 'no';
    kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }[];
}
export interface AdapterRunView {
  id: string;
  agent: string;
  workspace: string;
  state: 'starting' | 'idle' | 'running' | 'stopping' | 'closed' | 'failed';
  revision: number;
  transcript: string;
  truncated: boolean;
  permissions: AdapterPermission[];
  error?: string;
}
interface Run {
  view: AdapterRunView;
  controller: string;
  session?: AgentSession;
  abort: AbortController;
  unsubscribe?: () => void;
  inputs: Map<string, string>;
  lastRead: number;
  stopTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  closing?: Promise<void>;
}
export interface AdapterSessionDependencies {
  runtime: AgentAdapterRuntime;
  listWorkspaces: () => Promise<readonly AdapterWorkspace[]>;
  /** Revalidate the physical directory on the executing host, not a controller-supplied path. */
  validateWorkspace: (root: string) => Promise<string>;
  isCurrent: () => boolean;
  isControllerAllowed?: (controller: string) => boolean;
  now?: () => number;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new AdapterSessionError('invalid-input');
  return value;
}
function id(value: unknown): string {
  const result = string(value, 128);
  if (!/^[a-zA-Z0-9:_-]+$/.test(result)) throw new AdapterSessionError('invalid-input');
  return result;
}
function errorCode(error: unknown): string {
  return error instanceof NativeAgentError ? error.code : 'unavailable';
}
const MAX_TRANSCRIPT = 60_000;

/** One owner runtime. Each controller owns its runs; reads never resume or replay input. */
export function createAdapterSessionService(deps: AdapterSessionDependencies) {
  const runs = new Map<string, Run>();
  const starts = new Map<string, { fingerprint: string; runId: string }>();
  const now = deps.now ?? Date.now;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const current = () => !disposed && !deps.runtime.signal.aborted && deps.isCurrent();
  const assertCurrent = (controller = 'local') => {
    if (!current()) throw new AdapterSessionError('stale');
    if (!deps.runtime.enabled) throw new AdapterSessionError('disabled');
    if (deps.isControllerAllowed && !deps.isControllerAllowed(controller))
      throw new AdapterSessionError('unavailable');
  };
  const changed = (run: Run) => {
    run.view.revision++;
  };
  const append = (run: Run, text: string) => {
    run.view.transcript += text;
    if (run.view.transcript.length > MAX_TRANSCRIPT) {
      run.view.transcript = run.view.transcript.slice(-MAX_TRANSCRIPT);
      run.view.truncated = true;
    }
    changed(run);
  };
  const snapshot = (run: Run): AdapterRunView => structuredClone(run.view);
  const requireRun = (controller: string, runId: unknown): Run => {
    assertCurrent(controller);
    const run = runs.get(id(runId));
    if (!run || run.controller !== controller) throw new AdapterSessionError('not-found');
    run.lastRead = now();
    return run;
  };
  const close = (run: Run): Promise<void> => {
    if (run.closing) return run.closing;
    run.closing = Promise.resolve()
      .then(() => run.session?.close())
      .catch(() => {});
    clearTimeout(run.stopTimer);
    run.unsubscribe?.();
    run.abort.abort();
    run.view.permissions = [];
    run.view.state = 'closed';
    changed(run);
    return run.closing;
  };
  const onEvent = (run: Run, event: AgentAdapterEvent) => {
    if (!current() || run.abort.signal.aborted) return;
    const data = event.data as Record<string, unknown> | undefined;
    if (event.type === 'text' && typeof data?.text === 'string') append(run, data.text);
    else if (event.type === 'plan' && typeof data?.text === 'string')
      append(run, '\n' + data.text + '\n');
    else if (event.type === 'tool')
      append(run, '\n' + String(data?.title ?? '') + ' · ' + String(data?.status ?? '') + '\n');
    else if (event.type === 'permission') {
      run.view.permissions.push(structuredClone(event.data as AdapterPermission));
      changed(run);
    } else if (event.type === 'permission.resolved') {
      run.view.permissions = run.view.permissions.filter((p) => p.id !== data?.id);
      changed(run);
    } else if (event.type === 'permissions.cleared') {
      run.view.permissions = [];
      changed(run);
    } else if (event.type === 'closed') {
      if (run.view.state !== 'failed') run.view.state = 'closed';
      run.view.permissions = [];
      changed(run);
    }
  };
  const service = {
    async catalog(controller = 'local') {
      assertCurrent(controller);
      const [discovery, workspaces] = await Promise.all([
        deps.runtime.discover(),
        deps.listWorkspaces(),
      ]);
      assertCurrent(controller);
      return {
        instances: discovery.agentInstances,
        nodes: deps.runtime.catalog().runtimeNodes,
        failures: discovery.failures.map((f) => ({
          adapterId: f.adapterId,
          runtimeNodeId: f.runtimeNodeId,
          code: 'discovery-failed',
        })),
        workspaces: workspaces.map(({ id, label }) => ({ id, label })),
      };
    },
    list(controller: string): AdapterRunView[] {
      assertCurrent(controller);
      return [...runs.values()]
        .filter((run) => run.controller === controller)
        .map((run) => {
          run.lastRead = now();
          return snapshot(run);
        });
    },
    get(controller: string, runId: unknown): AdapterRunView {
      return snapshot(requireRun(controller, runId));
    },
    async start(controller: string, input: Record<string, unknown>): Promise<AdapterRunView> {
      assertCurrent(controller);
      const requestId = id(input.requestId),
        instanceId = id(input.instanceId),
        workspaceId = id(input.workspaceId);
      const key = JSON.stringify([controller, requestId]),
        fingerprint = JSON.stringify([instanceId, workspaceId]);
      const existing = starts.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AdapterSessionError('invalid-input');
        return service.get(controller, existing.runId);
      }
      const workspaces = await deps.listWorkspaces();
      assertCurrent(controller);
      const workspace = workspaces.find((w) => w.id === workspaceId);
      if (!workspace) throw new AdapterSessionError('unavailable');
      const root = await deps.validateWorkspace(workspace.root);
      assertCurrent(controller);
      // Recheck after awaits so concurrent retries cannot start two native processes.
      if (starts.has(key)) return service.start(controller, input);
      const active = [...runs.values()].filter((r) => !['closed', 'failed'].includes(r.view.state));
      if (runs.size >= 256) {
        const oldest = [...runs.values()].find((r) => ['closed', 'failed'].includes(r.view.state));
        if (oldest) {
          void close(oldest);
          runs.delete(oldest.view.id);
        }
      }
      if (
        active.length >= 64 ||
        active.filter((r) => r.controller === controller).length >= 16 ||
        runs.size >= 256 ||
        starts.size >= 4096
      )
        throw new AdapterSessionError('limit');
      const instance = deps.runtime
        .catalog()
        .agentInstances.find((i) => i.id === instanceId && i.runtimeNodeId === 'local');
      if (!instance) throw new AdapterSessionError('unavailable');
      const run: Run = {
        controller,
        abort: new AbortController(),
        inputs: new Map(),
        lastRead: now(),
        view: {
          id: randomUUID(),
          agent: instance.displayName,
          workspace: workspace.label,
          state: 'starting',
          revision: 1,
          transcript: '',
          truncated: false,
          permissions: [],
        },
      };
      runs.set(run.view.id, run);
      starts.set(key, { fingerprint, runId: run.view.id });
      run.starting = deps.runtime
        .start({
          sessionId: run.view.id,
          instanceId,
          runtimeNodeId: 'local',
          workspace: { id: workspace.id, root, runtimeNodeId: 'local' },
          signal: run.abort.signal,
        })
        .then(async (session) => {
          if (
            !current() ||
            run.abort.signal.aborted ||
            deps.isControllerAllowed?.(controller) === false
          ) {
            await session.close();
            await close(run);
            return;
          }
          run.session = session;
          run.view.state = 'idle';
          run.unsubscribe = session.onEvent((e) => onEvent(run, e));
          changed(run);
        })
        .catch((error) => {
          if (!current() || run.abort.signal.aborted) return;
          run.view.state = 'failed';
          run.view.error = errorCode(error);
          changed(run);
        });
      return snapshot(run);
    },
    send(controller: string, runId: unknown, input: Record<string, unknown>): AdapterRunView {
      const run = requireRun(controller, runId),
        requestId = id(input.requestId),
        body = string(input.text, 32_000);
      const fingerprint = createHash('sha256').update(body).digest('hex');
      if (run.inputs.has(requestId)) {
        if (run.inputs.get(requestId) !== fingerprint)
          throw new AdapterSessionError('invalid-input');
        return snapshot(run);
      }
      if (run.view.state !== 'idle' || !run.session) throw new AdapterSessionError('busy');
      if (run.inputs.size >= 1000) throw new AdapterSessionError('limit');
      run.inputs.set(requestId, fingerprint);
      run.view.state = 'running';
      delete run.view.error;
      append(run, '\n› ' + body + '\n\n');
      void run.session
        .send({ text: body })
        .then(() => {
          if (
            current() &&
            !run.abort.signal.aborted &&
            ['running', 'stopping'].includes(run.view.state)
          ) {
            run.view.state = 'idle';
            changed(run);
          }
        })
        .catch((error) => {
          if (current() && !run.abort.signal.aborted) {
            run.view.state = 'failed';
            run.view.error = errorCode(error);
            changed(run);
            void run.session?.close().catch(() => {});
          }
        })
        .finally(() => {
          clearTimeout(run.stopTimer);
        });
      return snapshot(run);
    },
    async permission(
      controller: string,
      runId: unknown,
      input: Record<string, unknown>,
    ): Promise<AdapterRunView> {
      const run = requireRun(controller, runId);
      const requestId = id(input.permissionId),
        optionId = input.optionId === null ? null : string(input.optionId, 160);
      if (!run.view.permissions.some((p) => p.id === requestId) || !run.session?.respondPermission)
        throw new AdapterSessionError('stale');
      await run.session.respondPermission(requestId, optionId);
      assertCurrent(controller);
      return snapshot(run);
    },
    async stop(controller: string, runId: unknown): Promise<AdapterRunView> {
      const run = requireRun(controller, runId);
      if (run.view.state === 'starting') {
        await close(run);
        return snapshot(run);
      }
      if (run.view.state !== 'running') return snapshot(run);
      run.view.state = 'stopping';
      changed(run);
      // Cooperative cancellation first; a hung native process is force-closed after a bounded grace.
      run.stopTimer = setTimeout(() => {
        void close(run);
      }, 5_000);
      await run.session?.stop();
      assertCurrent(controller);
      return snapshot(run);
    },
    async close(controller: string, runId: unknown): Promise<AdapterRunView> {
      const run = requireRun(controller, runId);
      await close(run);
      assertCurrent(controller);
      return snapshot(run);
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      disposal = Promise.allSettled(
        [...runs.values()].flatMap((run) => [close(run), run.starting]),
      ).then(() => {
        runs.clear();
        starts.clear();
      });
      return disposal;
    },
    /** One failed/offline/revoked controller cannot stop another controller's runs. */
    reap(isControllerAllowed: (controller: string) => boolean) {
      for (const run of runs.values()) {
        if (
          run.controller !== 'local' &&
          (!isControllerAllowed(run.controller) || now() - run.lastRead > 180_000)
        )
          void close(run);
      }
    },
  };
  return service;
}
export type AdapterSessionService = ReturnType<typeof createAdapterSessionService>;
