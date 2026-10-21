// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';
import type { VoiceQuestionBridge } from '../components/new-chat/voiceQuestionSelection';
import type { AskUserQuestionItem } from '@/lib/makerChatStore';

// Real question wizard + its renderer-local voice entry. No provider/network
// calls: verifies canonical answer encoding, confirmation and request boundaries.
beforeEach(async () => { await i18n.changeLanguage('en'); });
afterEach(cleanup);

function setup(question: Partial<AskUserQuestionItem> = {}) {
  const voiceBridge: VoiceQuestionBridge = { current: null };
  const props = {
    sessionId: 'task',
    pending: {
      requestId: 'question-1',
      questions: [{ question: 'Choose a plan', options: [{ label: '简洁' }, { label: '详细' }, { label: '表格' }], ...question }],
    },
    onAnswer: vi.fn(),
    viewerState: 'expanded' as const,
    onViewerStateChange: vi.fn(),
    draft: null,
    onDraftChange: vi.fn(),
    voiceBridge,
  };
  const view = render(createElement(AskUserQuestionPrompt, props));
  const say = (text: string) => act(() => voiceBridge.current?.receive(text));
  return { view, props, say };
}

describe('ordinary question voice choices', () => {
  it.each(['第一项', '第一个', '我选简洁。', '简洁', 'first option', 'option 1', '第一個'])(
    'submits a clear single choice through the card: %s', (text) => {
      const f = setup();
      f.say(text);
      expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '简洁' });
      // No receipt yet: keep the original question and draft retryable.
      expect(f.view.getByText('Choose a plan')).toBeTruthy();
      expect(f.props.onDraftChange.mock.lastCall?.[0]?.answers).toEqual({ 'Choose a plan': '简洁' });
    },
  );

  it('numbers only visible options, not the upstream Other placeholder', () => {
    const f = setup({ options: [{ label: 'Other' }, { label: '简洁' }, { label: '详细' }] });
    f.say('第一项');
    expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁' });
  });

  it('previews multi-select, allows cancellation, and confirms canonical visual order', () => {
    const f = setup({ multiSelect: true });
    f.say('第三项和第一项');
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual(['表格', '简洁']);
    f.say('取消选择');
    expect(f.props.onDraftChange.mock.lastCall?.[0]?.selectedLabels).toEqual([]);
    f.say('确认选择');
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    f.say('第三项和第一项');
    f.say('确认选择');
    expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
  });

  it.each(['第一项或第二项', '第一项和第二项', '不要选第一项', '他说第一项', '第九项', '简'])(
    'does not guess or submit ambiguous/unmatched speech: %s', (text) => {
      const f = setup();
      f.say(text);
      f.say('确认选择');
      expect(f.props.onAnswer).not.toHaveBeenCalled();
      expect(f.view.getByText(/No clear option recognized/)).toBeTruthy();
    },
  );

  it('requires disambiguation for duplicate labels', () => {
    const f = setup({ options: [{ label: '方案' }, { label: '方案。' }] });
    f.say('方案');
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    expect(f.view.getByText(/Your choice is unclear/)).toBeTruthy();
  });

  it('previews a free answer and confirms through the existing draft', () => {
    const f = setup({ options: [] });
    f.say('请安排在周六下午');
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    expect(f.props.onDraftChange.mock.lastCall?.[0]?.customInput).toBe('请安排在周六下午');
    fireEvent.click(f.view.getByRole('button', { name: 'Submit' }));
    expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '请安排在周六下午' });
  });

  it('shares manual multi-selection and changes the ASR target on edits', () => {
    const f = setup({ multiSelect: true });
    f.say('第一项');
    const beforeEdit = f.props.voiceBridge.current;
    fireEvent.click(f.view.getByText('详细'));
    expect(f.props.voiceBridge.current).not.toBe(beforeEdit);
    f.say('确认选择');
    expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '["简洁","详细"]' });
  });

  it('adds consecutive spoken choices without prematurely submitting', () => {
    const f = setup({ multiSelect: true });
    f.say('第一项');
    f.say('第三项');
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    f.say('确认选择');
    expect(f.props.onAnswer).toHaveBeenCalledExactlyOnceWith('question-1', { 'Choose a plan': '["简洁","表格"]' });
  });

  it('scopes targets to wizard steps and request identity, and removes them when voice closes', async () => {
    const f = setup();
    f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: {
      ...f.props.pending, questions: [...f.props.pending.questions, { question: 'When?', options: [{ label: '明天' }] }],
    } }));
    const first = f.props.voiceBridge.current;
    f.say('第一项');
    expect(f.props.voiceBridge.current).toBeNull();
    await waitFor(() => expect(f.props.voiceBridge.current).not.toBeNull());
    expect(f.props.voiceBridge.current).not.toBe(first);
    act(() => first?.receive('第一项'));
    expect(f.props.onAnswer).not.toHaveBeenCalled();
    f.say('明天');
    expect(f.props.onAnswer).toHaveBeenCalledWith('question-1', { 'Choose a plan': '简洁', 'When?': '明天' });
    const previous = f.props.voiceBridge.current;
    f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, pending: { ...f.props.pending, requestId: 'question-2' } }));
    expect(f.props.voiceBridge.current).not.toBe(previous);
    f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, voiceBridge: undefined }));
    expect(f.props.voiceBridge.current).toBeNull();
  });

  it('restores a minimized card for a voice answer', () => {
    const f = setup();
    f.view.rerender(createElement(AskUserQuestionPrompt, { ...f.props, viewerState: 'minimized' }));
    f.say('第一项');
    expect(f.props.onViewerStateChange).toHaveBeenCalledWith('expanded');
  });
});
