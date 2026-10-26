import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComposerDraft } from '@/lib/composerDraftStore';
import type { RegionScreenshotComposeRequest } from '../../../../shared/regionScreenshot';

const drafts = vi.hoisted(() => ({ current: undefined as ComposerDraft | undefined }));
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('@/lib/composerDraftStore', () => ({
  getDraft: () => drafts.current,
  saveDraft: (_key: string, value: ComposerDraft) => {
    drafts.current = value;
  },
  draftHasContent: (value?: ComposerDraft) =>
    !!value && (!!value.text || value.attachments.length > 0),
  plainTextToTiptapDoc: (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }),
}));
import { applyScreenshotComposeRequest } from '../screenshotTaskHandoff';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { takeComposerSubmitRequest } from '@/lib/composerActionsBus';

const original: ComposerDraft = {
  text: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'my original draft' }] }],
  },
  attachments: [],
};
const request = (id: string, action = 'translate'): RegionScreenshotComposeRequest => ({
  id,
  action: action as RegionScreenshotComposeRequest['action'],
  url: `image:${id}`,
  filename: `${id}.png`,
  bytes: 16,
  width: 2,
  height: 2,
});

// 测试价值：生产 applyScreenshotComposeRequest 保护连续 AI 操作和恢复期间的新输入。
// 既有 bus 测试只验证一次性消费，不验证草稿；最小失败输入为两次动作、清空、推进 500ms。
// tier: unit，草稿存储为内存 fake；不启动编辑器或真实发送。
describe('screenshot draft restoration', () => {
  afterEach(async () => {
    await vi.runAllTimersAsync();
    takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY);
    vi.useRealTimers();
    drafts.current = undefined;
  });
  it('retains the original draft across consecutive quick actions', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('a'), vi.fn());
    applyScreenshotComposeRequest(request('b'), vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    drafts.current = undefined;
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
  });
  it('merges the original with text entered after a successful send', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('c'), vi.fn());
    drafts.current = {
      text: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'new typing' }] }],
      },
      attachments: [],
    };
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
    expect(JSON.stringify(drafts.current)).toContain('new typing');
  });
  it('preserves ask attachments alongside an outstanding automatic action', async () => {
    vi.useFakeTimers();
    drafts.current = original;
    applyScreenshotComposeRequest(request('d'), vi.fn());
    applyScreenshotComposeRequest(request('e', 'ask'), vi.fn());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.stringify(drafts.current)).toContain('my original draft');
    expect(drafts.current?.attachments.map((file) => file.url)).toEqual(['image:d', 'image:e']);
    expect(takeComposerSubmitRequest(NEW_MAKER_DRAFT_KEY)).toBeNull();
  });
});
