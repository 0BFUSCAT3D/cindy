import fs from 'node:fs';
import path from 'node:path';
import { createDiscordIM, createWecomIM, createDingTalkIM, createTelegramIM, type TelegramIMOptions, type DiscordIMOptions, type BaseIM, type TextChannelIM } from '@cindy/im';
import { buildTelegramAdapter } from '@cindy/im-runtime/channels/telegram/adapter';
import { telegramUiText } from '@cindy/im-runtime/channels/telegram/uiText';
import { createTelegramSpeakerRegistration } from '@cindy/im-runtime/channels/telegram/contacts';
import { createTelegramBotMcpServer } from '@cindy/im-runtime/telegramBotMcpServer';
import { createGroupHistoryMcpServer } from '@cindy/im-runtime/groupHistoryMcpServer';
import type { TerminalKnowledge } from '../knowledge.js';
import { TerminalTelegramSettings } from './telegram-settings.js';
import { buildDingTalkAdapter, dingtalkManagedWorkingDirName } from '@cindy/im-runtime/channels/dingtalk/adapter';
import { buildWecomAdapter } from '@cindy/im-runtime/channels/wecom/adapter';
import { WecomTextInteractions } from '@cindy/im-runtime/channels/wecom/textInteractions';
import { buildDiscordAdapter } from '@cindy/im-runtime/channels/discord/adapter';
import { discordUiText } from '@cindy/im-runtime/channels/discord/uiText';
import { IM_DEFAULT_SETTINGS, IM_DEFAULT_EFFORT_OVERRIDES } from '@cindy/im-runtime/imDefaultSettings';
import { TerminalImTransportHost } from './transport-host.js';
import { TerminalGroupWindows } from './group-window.js';
export const TERMINAL_IM_CHANNELS = ['discord', 'wecom', 'dingtalk', 'telegram'] as const;
export type TerminalImChannel = typeof TERMINAL_IM_CHANNELS[number];
const configurationChannels = {
  discord: { read: 'discordBot:get-status', save: 'discordBot:set-config', disconnect: 'discordBot:disconnect' },
  wecom: { read: 'wecomBot:get-status', save: 'wecomBot:set-config', disconnect: 'wecomBot:disconnect' },
  dingtalk: { read: 'dingtalkBot:get-state', save: 'dingtalkBot:save', disconnect: 'dingtalkBot:clear' },
  telegram: { read: 'telegramBot:get-status', save: 'telegramBot:set-config', disconnect: 'telegramBot:disconnect' },
};

/** Each connection uses the official transport with the same owner-scoped
 * task runtime. No transport module imports Electron or starts a renderer. */
export class TerminalImConnections {
  readonly transport: TerminalImTransportHost;
  readonly discord;
  readonly wecom;
  readonly dingtalk;
  readonly telegram;
  readonly telegramSettings: TerminalTelegramSettings;
  readonly groups: TerminalGroupWindows;
  private readonly connections: Array<BaseIM & TextChannelIM>;
  private readonly subscriptions: Array<() => void> = [];
  private revision = 0;
  private closing?: Promise<void>;
  private starting?: Promise<void>;
  constructor(private readonly options: ConstructorParameters<typeof TerminalImTransportHost>[0] & { knowledge?: TerminalKnowledge }, native: { discord?: DiscordIMOptions; telegram?: TelegramIMOptions } = {}) {
    this.transport = new TerminalImTransportHost(options);
    this.groups = new TerminalGroupWindows(options.root, options.assertCurrent, options.logger);
    options.tasks.configureChannelTools(context => {
      const getSessionContext = () => {
        if (this.closing) throw new Error('IM_ACCOUNT_SCOPE_CLOSED');
        options.assertCurrent(); return context();
      };
      return {
        cindy_telegram_bot: () => createTelegramBotMcpServer({ getSessionContext }, options.logger),
        cindy_group_history: () => createGroupHistoryMcpServer({ getSessionContext, search: this.groups.search }, options.logger),
      };
    });
    void this.groups.ready.catch(() => {}); // start() reports initialization failures.
    this.discord = createDiscordIM(this.transport.host, {
      ...native.discord,
      resolveImageUrl: url => { const file = this.transport.host.media!.resolveMediaUrl(url); if (!file) throw new Error('INVALID_MEDIA_URL'); return file; },
      expiredCardNotice: discordUiText.expiredCardNotice,
    });
    this.wecom = createWecomIM(this.transport.host);
    this.dingtalk = createDingTalkIM(this.transport.host);
    this.telegramSettings = new TerminalTelegramSettings(options.root, options.assertCurrent);
    void this.telegramSettings.ready.catch(() => {});
    this.telegram = createTelegramIM(this.transport.host, { ...native.telegram,
      resolveImageUrl: url => { const file = this.transport.host.media!.resolveMediaUrl(url); if (!file) throw new Error('INVALID_MEDIA_URL'); return file; },
      expiredCardNotice: telegramUiText.expiredCardNotice, behavior: () => this.telegramSettings.behavior(),
    });
    this.connections = [this.discord, this.wecom, this.dingtalk, this.telegram];
    const config = { agentKind: IM_DEFAULT_SETTINGS.agentKind, defaultModel: IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
      defaultPermissionMode: IM_DEFAULT_SETTINGS.permissionMode, effortOverrides: IM_DEFAULT_EFFORT_OVERRIDES };
    options.tasks.channelOrchestrators.attach(buildDiscordAdapter(this.discord, config, appId => {
      options.assertCurrent();
      if (!/^[\w-]{1,128}$/.test(appId)) throw new Error('INVALID_IM_CONTEXT');
      const directory = path.join(options.root, 'im-working-dir', `discord-${appId}`);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      return directory;
    }));
    options.tasks.channelOrchestrators.attach(buildWecomAdapter(this.wecom, new WecomTextInteractions(this.wecom), config, {
      log: options.logger, window: this.groups.channel('wecom-personal'), ensureWorkingDir: botId => {
        options.assertCurrent();
        const directory = path.join(options.root, 'im-working-dir', `wecom-${Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96)}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    options.tasks.channelOrchestrators.attach(buildDingTalkAdapter(this.dingtalk, config, {
      log: options.logger, window: this.groups.channel('dingtalk-personal'), ensureWorkingDir: appKey => {
        options.assertCurrent();
        const directory = path.join(options.root, 'im-working-dir', dingtalkManagedWorkingDirName(appKey));
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    const telegramWindow = this.groups.channel('telegram-personal');
    const contacts = createTelegramSpeakerRegistration({
      enabled: () => options.knowledge?.snapshot().contacts === true,
      getStore: () => { options.assertCurrent(); if (!options.knowledge) throw new Error('CONTACTS_DISABLED'); return options.knowledge.contacts.getStore(); },
      changed: () => options.emit('maker:remote-resources:changed', { collectionId: 'contacts' }), log: options.logger,
    });
    options.tasks.channelOrchestrators.attach(buildTelegramAdapter(this.telegram, config, {
      buildTelegramGroupContextPrefix: args => telegramWindow.buildContextPrefix(args),
      readTelegramPersona: () => this.telegramSettings.persona(),
      autoRegisterTelegramSpeaker: contacts.autoRegisterTelegramSpeaker,
      ensureWorkingDir: botId => {
        options.assertCurrent(); if (!/^\d+$/.test(botId)) throw new Error('INVALID_IM_CONTEXT');
        const directory = path.join(options.root, 'im-working-dir', `telegram-${botId}`);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
      },
    }));
    this.subscriptions.push(this.telegram.onGroupWindowMessage(entry => {
      const account = options.tasks.channelControl.account, generation = account.captureImAccountGeneration();
      if (generation === null) return;
      void account.runInImAccountGeneration(generation, () => telegramWindow.record(entry)).catch(() => options.logger.warn('IM_GROUP_HISTORY_RECORD_FAILED'));
    }));
    const ipc = this.transport.host.ipc;
    ipc.handle('telegramBot:get-behavior', () => this.telegramSettings.behavior());
    ipc.handle('telegramBot:set-behavior', patch => this.telegramSettings.patchBehavior((patch ?? {}) as Parameters<TerminalTelegramSettings['patchBehavior']>[0]));
    ipc.handle('telegramBot:get-persona', () => this.telegramSettings.persona());
    ipc.handle('telegramBot:set-persona', async input => {
      const payload = (input ?? {}) as { botName?: string; soul?: string; syncProfile?: boolean };
      const persona = await this.telegramSettings.patchPersona({
        ...(typeof payload.botName === 'string' ? { botName: payload.botName } : {}),
        ...(typeof payload.soul === 'string' ? { soul: payload.soul } : {}),
      });
      return { persona, ...(payload.syncProfile === true ? { profileSynced: await this.telegram.syncBotProfileName(persona.botName) } : {}) };
    });
    ipc.handle('telegramBot:list-groups', async () => {
      const groups = await telegramWindow.listKnownGroups(this.telegram.botContextId), activation = this.telegramSettings.behavior().groupActivation ?? {};
      return { groups: groups.map(group => ({ ...group, activation: activation[group.chatId] ?? 'mention' })) };
    });
    ipc.handle('telegramBot:set-group-activation', payload => {
      const input = (payload ?? {}) as { chatId?: string; mode?: string };
      return this.telegramSettings.activate(input.chatId ?? '', input.mode === 'always' ? 'always' : 'mention');
    });
    for (const connection of this.connections) {
      connection.registerIpc();
      this.subscriptions.push(connection.onStatusChange(() => {
        this.revision += 1;
        options.emit('maker:remote-resources:changed', { collectionId: 'channels' });
      }));
    }
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    return this.starting = (async () => {
      this.options.assertCurrent();
      await Promise.all([this.groups.ready, this.telegramSettings.ready]);
      if (this.closing) return;
      const results = await Promise.allSettled(this.connections.map(connection => connection.init()));
      if (this.closing) return;
      this.options.assertCurrent();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'IM_CONNECTION_START_FAILED');
    })();
  }
  version() { return this.revision; }
  channel(id: string): TerminalImChannel {
    if (!TERMINAL_IM_CHANNELS.includes(id as TerminalImChannel)) throw new Error('IM_CHANNEL_NOT_FOUND');
    return id as TerminalImChannel;
  }
  status(id: TerminalImChannel) { return this[id].getStatus(); }
  readConfiguration(id: TerminalImChannel) { return this.invoke(configurationChannels[id].read, undefined); }
  async saveConfiguration(id: string, input: unknown) {
    const result = await this.invoke(configurationChannels[this.channel(id)].save, input) as { saveErrorStatus?: unknown; status?: { kind?: string } };
    if (result.saveErrorStatus || result.status?.kind === 'error') throw new Error('IM_CONFIGURATION_SAVE_FAILED');
  }
  disconnect(id: TerminalImChannel) { return this.invoke(configurationChannels[id].disconnect, undefined); }
  accepts(channel: string) { return this.transport.channels().includes(channel); }
  async invoke(channel: string, input: unknown) {
    const result = await this.transport.invoke(channel, input);
    if (!channel.endsWith(':get-status') && !channel.endsWith(':get-state')) this.revision += 1;
    return result;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Close event admission before awaiting gateway shutdown. Active requests
    // keep their old task owner, and all listeners are detached by the runtime.
    const handlers = this.options.tasks.channelControl.close();
    for (const stop of this.subscriptions.splice(0)) stop();
    return this.closing = (async () => {
      const results = await Promise.allSettled([
        this.options.tasks.channelOrchestrators.close(),
        ...this.connections.map(connection => connection.dispose()),
      ]);
      // Initialization may have been waiting on network I/O when shutdown
      // began. Drain it and dispose any late connection before releasing data.
      await this.starting?.catch(() => {});
      results.push(...await Promise.allSettled(this.connections.map(connection => connection.dispose())));
      await handlers;
      this.transport.close();
      await Promise.all([this.groups.close(), this.telegramSettings.close()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'IM_CONNECTION_CLEANUP_FAILED');
    })();
  }
}
