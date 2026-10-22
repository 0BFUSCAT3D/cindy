import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

mountPage({
  route: '/bots/fixture-cindy?settings=1&settingsPage=channels',
  host: (ctx) => ({
    botImConnection: {
      list: async () => ({ connections: ctx.data.hiddenIm ? [{
        id: 'fixture-feishu', botId: 'fixture-cindy', channel: 'feishu', createdAt: 1,
        botContextId: 'cli_aa53dc2c', status: { kind: 'connected', appId: 'cli_aa53dc2c' },
        identity: { ownerUserId: 'owner' },
      }] : [] }),
      listLanes: async () => ({ connectionId: 'fixture-feishu', lanes: [
        { sessionId: 'fixture-main', kind: 'owner-dm', name: null, chatId: null, threadId: null,
          state: 'idle', lastActivityAt: Date.now() - 3600000, contextMessageCount: 0 },
        { sessionId: 'fixture-topic', kind: 'topic', name: '拉拉, 徐紫旎, 姚刘浏', chatId: 'group', threadId: '8c9b5c',
          state: 'running', lastActivityAt: Date.now() - 300000, contextMessageCount: 11 },
      ] }),
      resetLane: forbid('botImConnection.resetLane'),
      onChanged: subscription('connections'),
    },
    maker: {
      imDefaultSettingsGet: async () => ({ agentKind: 'codex', agents: { codex: { model: 'gpt-6.1-sol' } } }),
    },
    wechatBot: {
      getState: async () => ({ phase: ctx.data.bound ? 'connected' : 'disconnected', bound: !!ctx.data.bound, queuedTasks: 0 }),
      getChannelSettings: async () => ({ version: 1, workingDir: null, workingDirAvailable: true, companionBotId: ctx.data.companionBotId }),
      onStateChange: subscription('wechatState'),
      onChannelSettingsChange: subscription('wechatSettings'),
      setCompanion: forbid('wechatBot.setCompanion'),
      authorize: forbid('wechatBot.authorize'),
      unbind: forbid('wechatBot.unbind'),
    },
  }),
  render: () => <div className="mx-auto max-w-2xl p-4"><BotChannelsPage bot={{
    id: 'fixture-cindy', name: 'Cindy', status: 'active',
  } as BotProfile} /></div>,
});
