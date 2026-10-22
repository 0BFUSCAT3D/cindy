import { resolveRemoteText, type RemoteResource } from '@cindy/device-link';
import {
  agentAdapterCopy as copy,
  AGENT_ADAPTER_COLLECTION as collectionId,
  AGENT_ADAPTER_KIND as kind,
} from '@cindy/maker-shared/agent-adapters';
import { mountPage, ctx, subscription, forbid } from '../../ui-page/harness';
import { AgentAdaptersPage } from '../../../src/renderer/features/agent-adapters/AgentAdaptersPage';

function resource(): RemoteResource {
  const text = (value: typeof copy.title) => resolveRemoteText(value, ctx.locale);
  if (ctx.case === 'auth')
    return {
      ref: { collectionId, kind, id: 'run-1' },
      revision: '2',
      display: {
        title: 'Gemini CLI',
        subtitle: 'Cindy',
        status: { label: copy.failed, tone: 'critical' },
      },
      links: [],
      blocks: [{ id: 'error', primitive: 'text', fallbackMarkdown: text(copy.auth) }],
      actions: [],
    };
  if (ctx.case === 'permission')
    return {
      ref: { collectionId, kind, id: 'run-1' },
      revision: '4',
      display: { title: 'Cursor', subtitle: 'Cindy', status: { label: copy.running } },
      links: [],
      blocks: [
        {
          id: 'output',
          primitive: 'text',
          fallbackMarkdown:
            '› Review the project and explain the next change.\n\nI found the relevant module. The next step is to update the adapter and run its tests.',
        },
      ],
      actions: [
        {
          id: 'permission:1',
          label: 'Run project tests',
          fields: [
            {
              id: 'optionId',
              kind: 'select',
              label: copy.choose,
              required: true,
              options: [
                { value: 'allow', label: 'Allow once' },
                { value: 'deny', label: 'Reject' },
              ],
            },
          ],
        },
        { id: 'stop', label: copy.stop },
      ],
    };
  return {
    ref: { collectionId, kind, id: 'catalog' },
    revision: '1',
    display: { title: copy.title },
    links: [],
    blocks: [
      { id: 'intro', primitive: 'text', fallbackMarkdown: text(copy.intro) },
      ...(ctx.case === 'empty'
        ? [{ id: 'empty', primitive: 'text', fallbackMarkdown: text(copy.empty) }]
        : []),
    ],
    actions:
      ctx.case === 'default'
        ? []
        : [
            {
              id: 'start',
              label: copy.newRun,
              disabled: ctx.case === 'empty',
              fields: [
                {
                  id: 'instanceId',
                  label: copy.agent,
                  kind: 'select',
                  required: true,
                  options:
                    ctx.case === 'empty'
                      ? []
                      : ['Cursor', 'OpenCode', 'CodeBuddy', 'Gemini CLI', 'Qwen Code'].map(
                          (label) => ({ value: label, label }),
                        ),
                },
                {
                  id: 'workspaceId',
                  label: copy.workspace,
                  kind: 'select',
                  required: true,
                  options: [
                    { value: 'p1', label: 'Cindy' },
                    { value: 'p2', label: 'Another project with a long name' },
                  ],
                },
              ],
            },
          ],
  };
}
mountPage({
  route: ['permission', 'auth'].includes(ctx.case)
    ? '/agent-adapters?run=run-1'
    : '/agent-adapters',
  host: {
    agentAdapters: {
      get: async () => resource(),
      settings: async () => ({
        enabled: ctx.case !== 'default',
        customized: ctx.case !== 'default',
      }),
      invoke: forbid('agentAdapters.invoke'),
      configure: forbid('agentAdapters.configure'),
      pickDirectory: forbid('agentAdapters.pickDirectory'),
    },
    deviceLink: {
      listDevices: async () => ({ devices: [] }),
      onPresenceChanged: subscription('presence'),
    },
  },
  render: () => <AgentAdaptersPage />,
});
