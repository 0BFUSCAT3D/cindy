import type { FeishuIM } from '@cindy/im';
import type { LiziMcpSessionContext } from '@cindy/mcps';
import { readChannelToolScope } from '@cindy/im-runtime/channelToolScope';
import type { createFeishuNotifications } from '@cindy/im-runtime/channels/feishu/notificationOrigin';
import { createFeishuBotMcpServer } from '../../../../packages/lizi-mcps/src/cindy_feishuBotMcpServer.js';
import type { TerminalTaskHost } from '../tasks/host.js';

export function createTerminalFeishuTools(host: {
  getSessionContext(): LiziMcpSessionContext;
  tasks: TerminalTaskHost;
  source?: string;
  personal: FeishuIM;
  notifications: ReturnType<typeof createFeishuNotifications>;
}) {
  const lane = () => {
    const context = host.getSessionContext(), scope = readChannelToolScope(context);
    return scope?.channel === 'feishu' ? { ...scope, workingDir: context.workingDir } : null;
  };
  const resolve = async (target?: string) => {
    const context = host.getSessionContext(), current = lane();
    if (current) {
      const assertCurrent = () => {
        const next = lane();
        if (!next || next.im !== current.im || next.triggerMessageId !== current.triggerMessageId || next.chatId !== current.chatId ||
          target && target !== current.laneUserId) throw new Error('FEISHU_TURN_CHANGED');
      };
      assertCurrent();
      return { im: current.im, context, target: current.laneUserId, assertCurrent, notification: false };
    }
    const task = context.sessionId ? await host.tasks.storage.get(context.sessionId) : null;
    // A companion's connection must come from its own current lane. Never
    // silently substitute the personal bot's credentials for another bot.
    if (task?.source === 'bot') throw new Error('COMPANION_FEISHU_CONNECTION_UNAVAILABLE');
    const explicit = typeof context.vendorOptions?.feishuChatId === 'string' ? context.vendorOptions.feishuChatId : null;
    const recipient = explicit ?? host.personal.getOwnerOpenId();
    const assertCurrent = () => {
      host.getSessionContext();
      if (lane() || target && target !== recipient || !explicit && recipient !== host.personal.getOwnerOpenId()) throw new Error('FEISHU_RECIPIENT_CHANGED');
    };
    assertCurrent();
    return { im: host.personal, context, target: recipient, assertCurrent, notification: !explicit };
  };
  return createFeishuBotMcpServer({
    getLaneScope: lane,
    getChatId: async () => (await resolve()).target,
    sessionSource: host.source,
    sendFile: async (target, file, name) => {
      try { const resolved = await resolve(target); resolved.assertCurrent(); return await resolved.im.sendFile(target, file, name); }
      catch { return { ok: false, reason: 'SEND_FAIL' }; }
    },
    sendMessage: async (target, text) => {
      try {
        const resolved = await resolve(target); resolved.assertCurrent();
        if (resolved.notification && resolved.context.sessionId) {
          const receipt = await host.notifications.sendFeishuSessionNotification(host.personal, resolved.context.sessionId, text);
          return { ok: true, messageId: receipt.messageId, sessionLinked: receipt.sessionLinked };
        }
        return { ok: true, ...await resolved.im.sendMarkdownText(target, text) };
      } catch { return { ok: false, reason: 'SEND_FAIL' }; }
    },
  });
}
