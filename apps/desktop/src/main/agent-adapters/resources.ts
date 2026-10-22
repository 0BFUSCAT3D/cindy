import {
  resolveRemoteText,
  type RemoteActionDescriptor,
  type RemoteResource,
} from '@cindy/device-link';
import {
  AGENT_ADAPTER_COLLECTION as collectionId,
  AGENT_ADAPTER_KIND as kind,
  agentAdapterCopy as copy,
} from '@cindy/maker-shared/agent-adapters';
import {
  RemoteResourceRegistryError,
  type RemoteResourceProvider,
} from '../device-link/remoteResourceRegistry.js';
import {
  AdapterSessionError,
  type AdapterRunView,
  type AdapterSessionService,
} from './sessions.js';

export const agentResourceRef = (id: string) => ({ collectionId, kind, id });
export interface AdapterResourceDependencies {
  enabled: () => boolean;
  service: () => AdapterSessionService;
  /** Captures owner and trusted transport authorization; rechecked after every await. */
  guard: (controller: string) => () => void;
}
function runResource(run: AdapterRunView, locale?: string): RemoteResource {
  const actions: RemoteActionDescriptor[] = [];
  if (run.state === 'idle')
    actions.push({
      id: 'send',
      label: copy.send,
      fields: [{ id: 'text', kind: 'multiline', label: copy.message, required: true }],
    });
  if (['starting', 'running', 'stopping'].includes(run.state))
    actions.push({ id: 'stop', label: copy.stop, disabled: run.state === 'stopping' });
  for (const permission of run.permissions) {
    actions.push({
      id: 'permission:' + permission.id,
      label: permission.title || copy.choose,
      fields: [
        {
          id: 'optionId',
          label: copy.choose,
          kind: 'select',
          required: true,
          options: permission.options.map((option) => ({
            value: option.id,
            label: option.labelKey ? copy[option.labelKey] : option.label,
          })),
        },
      ],
    });
    actions.push({ id: 'deny:' + permission.id, label: copy.cancel });
  }
  if (!['closed', 'failed'].includes(run.state)) actions.push({ id: 'close', label: copy.close });
  const notice = run.error
    ? resolveRemoteText(
        run.error === 'needs-auth'
          ? copy.auth
          : run.error === 'auth-unavailable'
            ? copy.authUnavailable
            : copy.error,
        locale,
      )
    : '';
  return {
    ref: agentResourceRef(run.id),
    revision: String(run.revision),
    display: {
      title: run.agent,
      subtitle: run.workspace,
      status: { label: copy[run.state], tone: run.state === 'failed' ? 'critical' : 'neutral' },
    },
    links: [],
    actions,
    blocks: [
      ...(notice ? [{ id: 'error', primitive: 'text', fallbackMarkdown: notice }] : []),
      ...(run.truncated
        ? [
            {
              id: 'truncated',
              primitive: 'text',
              fallbackMarkdown: resolveRemoteText(copy.clipped, locale),
            },
          ]
        : []),
      { id: 'output', primitive: 'text', fallbackMarkdown: run.transcript },
    ],
  };
}

/** Same projections/actions for a trusted local renderer and an authorized Device Link controller. */
export function createAgentResourceProvider(
  deps: AdapterResourceDependencies,
): RemoteResourceProvider {
  const guarded = async <T>(controller: string, work: () => Promise<T>): Promise<T> => {
    const check = deps.guard(controller);
    check();
    try {
      const result = await work();
      check();
      return result;
    } catch (error) {
      if (error instanceof RemoteResourceRegistryError) throw error;
      throw new RemoteResourceRegistryError(
        error instanceof AdapterSessionError && error.code === 'invalid-input'
          ? 'INVALID_PARAMS'
          : 'NOT_FOUND',
        'External Agent unavailable',
      );
    }
  };
  const home = async (controller: string, locale?: string): Promise<RemoteResource> => {
    const enabled = deps.enabled();
    const base: RemoteResource = {
      ref: agentResourceRef('catalog'),
      revision: enabled ? 'enabled' : 'disabled',
      display: { title: copy.title, subtitle: enabled ? copy.newRun : copy.disabled },
      links: [],
      actions: [],
      blocks: [
        { id: 'intro', primitive: 'text', fallbackMarkdown: resolveRemoteText(copy.intro, locale) },
      ],
    };
    if (!enabled) {
      base.blocks!.push({
        id: 'disabled',
        primitive: 'text',
        fallbackMarkdown: resolveRemoteText(copy.remoteEnable, locale),
      });
      return base;
    }
    const service = deps.service(),
      catalog = await service.catalog(controller);
    const local = catalog.instances.filter(
      (i) => i.runtimeNodeId === 'local' && i.status === 'ready',
    );
    if (local.length === 0)
      base.blocks!.push({
        id: 'empty',
        primitive: 'text',
        fallbackMarkdown: resolveRemoteText(copy.empty, locale),
      });
    base.actions = [
      {
        id: 'start',
        label: copy.newRun,
        disabled: !local.length || !catalog.workspaces.length,
        fields: [
          {
            id: 'instanceId',
            label: copy.agent,
            kind: 'select',
            required: true,
            options: local.map((i) => ({ value: i.id, label: i.displayName })),
          },
          {
            id: 'workspaceId',
            label: copy.workspace,
            kind: 'select',
            required: true,
            options: catalog.workspaces.map((w) => ({ value: w.id, label: w.label })),
          },
        ],
      },
    ];
    base.links = service
      .list(controller)
      .reverse()
      .map((run) => ({
        rel: 'item',
        label:
          run.agent + ' · ' + run.workspace + ' · ' + resolveRemoteText(copy[run.state], locale),
        target: { kind: 'resource', ref: agentResourceRef(run.id) },
      }));
    return base;
  };
  return {
    collection: {
      id: collectionId,
      resourceKind: kind,
      title: copy.title,
      placement: 'navigation',
      icon: { name: 'terminal', fallbackText: 'A' },
    },
    list: (context, request) =>
      guarded(context.controllerDeviceId, async () => {
        const root = await home(context.controllerDeviceId, request.client.locale);
        const runs = deps.enabled()
          ? deps.service().list(context.controllerDeviceId).reverse()
          : [];
        const offset = request.cursor ? Number(request.cursor) : 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 256)
          throw new AdapterSessionError('invalid-input');
        const all = [
          root,
          ...runs.map((run) => ({
            ...runResource(run, request.client.locale),
            blocks: undefined,
            actions: undefined,
          })),
        ];
        const limit = request.limit ?? 50;
        return {
          collectionId,
          revision: String(all.length),
          items: all.slice(offset, offset + limit),
          ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
        };
      }),
    get: (context, request) =>
      guarded(context.controllerDeviceId, async () =>
        request.ref.id === 'catalog'
          ? home(context.controllerDeviceId, request.client.locale)
          : runResource(
              deps.service().get(context.controllerDeviceId, request.ref.id),
              request.client.locale,
            ),
      ),
    invoke: (context, request) =>
      guarded(context.controllerDeviceId, async () => {
        const controller = context.controllerDeviceId,
          service = deps.service(),
          input = request.input ?? {},
          runId = request.resourceRef?.id;
        let run: AdapterRunView;
        if (request.actionId === 'start' && runId === 'catalog')
          run = await service.start(controller, input);
        else if (!runId || runId === 'catalog') throw new AdapterSessionError('invalid-input');
        else if (request.actionId === 'send') run = service.send(controller, runId, input);
        else if (request.actionId === 'stop') run = await service.stop(controller, runId);
        else if (request.actionId === 'close') run = await service.close(controller, runId);
        else if (request.actionId.startsWith('permission:') || request.actionId.startsWith('deny:'))
          run = await service.permission(controller, runId, {
            permissionId: request.actionId.split(':')[1],
            optionId: request.actionId.startsWith('deny:') ? null : input.optionId,
          });
        else throw new AdapterSessionError('invalid-input');
        return {
          effects: [
            { kind: 'navigate', target: { kind: 'resource', ref: agentResourceRef(run.id) } },
          ],
        };
      }),
  };
}
