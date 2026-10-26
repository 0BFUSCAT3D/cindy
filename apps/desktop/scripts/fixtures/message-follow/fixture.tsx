import { useLayoutEffect, useRef, useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import {
  MessageViewport,
  type MessageViewportApi,
} from '../../../src/renderer/components/chat/MessageViewport';
import { useSmoothMessageFollow } from '../../../src/renderer/components/chat/useSmoothMessageFollow';
import { Button } from '../../../src/renderer/components/ui/button';

const entries = Array.from({ length: 100 }, (_, index) => ({
  key: String(index),
  retain: index === 99,
}));

function Thread() {
  const scroll = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const viewport = useRef<MessageViewportApi>(null);
  const follow = useSmoothMessageFollow(scroll, items);
  const [lines, setLines] = useState(1);
  const [bottomPadding, setBottomPadding] = useState(0);
  const [initialMotion, setInitialMotion] = useState<number | null>(null);
  // Like MessageStream's composer reservation, this measurement lands in a
  // second layout commit, after the first pin but before the first paint.
  useLayoutEffect(() => {
    setBottomPadding(120);
  }, []);
  useLayoutEffect(() => {
    viewport.current?.connect();
  });
  useLayoutEffect(() => {
    follow();
    viewport.current?.reconcileViewport();
  }, [follow, lines, bottomPadding]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (!following.current) return;
      follow();
      viewport.current?.syncViewport();
    });
    observer.observe(items.current!);
    return () => observer.disconnect();
  }, [follow]);
  useLayoutEffect(() => {
    let count = 0,
      max = 0,
      frame: number;
    const measure = () => {
      const transform = getComputedStyle(items.current!).transform;
      max = Math.max(
        max,
        transform === 'none' ? 0 : Math.abs(new DOMMatrixReadOnly(transform).m42),
      );
      if (++count < 20) frame = requestAnimationFrame(measure);
      else setInitialMotion(max);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <>
      <div className="flex items-center gap-4 px-6 py-3 border-b border-border">
        <span className="text-sm text-muted-foreground">任务消息</span>
        <Button variant="outline" size="sm" onClick={() => setLines((value) => value + 1)}>
          追加进展
        </Button>
        <output hidden data-initial-motion={initialMotion ?? ''} />
      </div>
      <div
        ref={scroll}
        data-thread-scroll
        className="h-[420px] overflow-y-auto"
        onWheel={() => {
          following.current = false;
        }}
      >
        <MessageViewport
          apiRef={viewport}
          options={{
            entries,
            scrollRef: scroll,
            itemsRef: items,
            followRef: following,
            disabled: false,
          }}
        >
          {(view) => (
            <div
              ref={items}
              data-thread-items
              className="flex flex-col gap-4 p-6"
              style={{ paddingBottom: bottomPadding }}
            >
              {entries.map((entry) =>
                !view.shouldMount(entry) ? (
                  <div
                    key={entry.key}
                    data-render-item-key={entry.key}
                    data-message-placeholder
                    style={{ height: view.placeholderHeight(entry.key), flexShrink: 0 }}
                  />
                ) : (
                  <div
                    key={entry.key}
                    data-render-item-key={entry.key}
                    className="text-sm leading-6"
                  >
                    <div className="text-muted-foreground">工作记录 {Number(entry.key) + 1}</div>
                    <p>正在核对任务结果，完成后继续下一步。</p>
                    {entry.key === '99' &&
                      Array.from({ length: lines }, (_, index) => (
                        <p key={index}>已验证第 {index + 1} 项结果。</p>
                      ))}
                  </div>
                ),
              )}
            </div>
          )}
        </MessageViewport>
      </div>
    </>
  );
}

function Fixture() {
  const [generation, setGeneration] = useState(0);
  return (
    <div data-ui-page-subject>
      <div className="p-4">
        <Button variant="outline" onClick={() => setGeneration((value) => value + 1)}>
          重新打开任务
        </Button>
      </div>
      <Thread key={generation} />
    </div>
  );
}

void mountPage({ render: () => <Fixture /> });
