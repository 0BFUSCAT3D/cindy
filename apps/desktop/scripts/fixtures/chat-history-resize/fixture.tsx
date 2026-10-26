import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { ThinkingCard } from '../../../src/renderer/components/chat/ThinkingCard';
import { WorkGroupBlock } from '../../../src/renderer/components/chat/WorkGroupBlock';
import { Button } from '../../../src/renderer/components/ui/button';
import type { ChatMessage } from '../../../src/renderer/lib/makerChatStore';

function Page({ scenario }: { scenario: string }) {
  const [count, setCount] = useState(1);
  const content = Array.from(
    { length: count },
    (_, i) => `第 ${i + 1} 项：历史详情分批补入，阅读位置应保持稳定。`,
  ).join('\n');
  return (
    <main data-scenario={scenario} className="p-6 space-y-5">
      <Button onClick={() => setCount(count === 1 ? 12 : 1)}>补入或收回内容</Button>
      <section data-card>
        {scenario.startsWith('thinking') || scenario === 'default' ? (
          <ThinkingCard
            blockKey="resize-fixture"
            content={content}
            durationMs={7000}
            isStreaming={scenario === 'thinking-streaming'}
          />
        ) : (
          <WorkGroupBlock
            blockId="resize-fixture-work"
            durationMs={7000}
            isStreaming={scenario === 'work-live'}
            childItems={
              scenario === 'work-live'
                ? Array.from({ length: count === 1 ? 1 : 5 }, (_, i) => ({
                    kind: 'thinking' as const,
                    key: `activity-${i}`,
                    message: {
                      id: i,
                      clientId: `activity-${i}`,
                      role: 'thinking',
                      content: `核对第 ${i + 1} 项历史内容。`,
                      createdAt: i + 1,
                    } as ChatMessage,
                  }))
                : [
                    {
                      kind: 'rendered',
                      key: 'body',
                      renderNode: () => <p className="whitespace-pre-wrap leading-6">{content}</p>,
                    },
                  ]
            }
          />
        )}
      </section>
      <p data-reading-anchor>后续回复：内容补入后，这一行不应持续上下漂移。</p>
    </main>
  );
}

mountPage({ render: (ctx) => <Page scenario={ctx.case} /> });
