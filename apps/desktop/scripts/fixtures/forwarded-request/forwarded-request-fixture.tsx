import { Route, Routes } from 'react-router-dom';
import { AppFrame, mountPage, subscription } from '../../ui-page/harness';
import { BotDirectMessageView } from '../../../src/renderer/features/bots/BotDirectMessageView';
import { BotDirectMessageCard } from '../../../src/renderer/features/bots/BotDirectMessageCard';
import { UserMessage } from '../../../src/renderer/components/chat/UserMessage';
import { formatForwardedRequest } from '../../../src/shared/forwardedRequest';
import type { SupportedLocale } from '../../../src/shared/locale';

const original = '请检查消息中的换行，保留代码和路径。';
const supplement = '第一段：消息现在正常换行。\n\n1. 保留段落与列表\n2. 保留有意书写的转义\n\n```js\nconst newline = "\\n";\nconst path = "C:\\\\new\\\\test";\n```\n\n最后一段：只检查，不发布。';

void mountPage({
  route: '/bots/bot-a/direct/thread',
  host: (ctx) => {
    const content = formatForwardedRequest({ userText: original }, supplement, ctx.locale as SupportedLocale);
    return { maker: {
      getBotDirectMessageThread: async () => ({ ok: true, thread: {
        id: 'thread', botAId: 'bot-a', botAName: 'Cindy', botBId: 'bot-b', botBName: 'Filo',
        status: 'active', closeReason: null, messageCount: 1, maxMessages: 12,
        messages: [{ id: 'message', sequence: 1, senderBotId: 'bot-a', senderBotName: 'Cindy',
          recipientBotId: 'bot-b', recipientBotName: 'Filo', content, createdAt: 1792629000000 }],
      } }),
      onBotDirectMessageChanged: subscription('directMessageChanged'),
      getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [], fork: { supported: false }, rewind: { supported: false } }),
    } };
  },
  render: (ctx) => {
    const content = formatForwardedRequest({ userText: original }, supplement, ctx.locale as SupportedLocale);
    if (ctx.case === 'task') return <div className="p-4" data-ui-page-subject>
      <UserMessage workingDir="" content={content} automationOrigin={{ kind: 'session', senderSessionId: 'sender', senderBotName: 'Cindy', senderBotId: 'bot-a' }} />
    </div>;
    if (ctx.case === 'card') return <div className="p-4" data-ui-page-subject>
      <BotDirectMessageCard data={{ v: 1, threadId: 'thread', viewerBotId: 'bot-a', peerBotId: 'bot-b', peerBotName: 'Filo', direction: 'sent', sequence: 1, preview: content.slice(0, 400) }} />
    </div>;
    return <AppFrame sidebarWidth={0}><Routes><Route path="/bots/:botId/direct/:threadId" element={<BotDirectMessageView />} /></Routes></AppFrame>;
  },
});
