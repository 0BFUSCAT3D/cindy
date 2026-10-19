// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PendingAskUser } from '@/lib/makerChatStore';
import { _clearSmartResolveCache } from '@/lib/localPathResolver';
import { AskUserQuestionPrompt } from '../components/new-chat/AskUserQuestionPrompt';

const links = vi.hoisted(() => ({ html: vi.fn(), url: vi.fn() }));
vi.mock('@/components/chat/useOpenWithMenu', async (original) => ({
  ...await original<typeof import('@/components/chat/useOpenWithMenu')>(),
  openHtmlFileByPreference: links.html,
  activateMessageUrl: links.url,
}));

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

function renderAskUser(
  pending: PendingAskUser,
  onAnswer: (requestId: string, answers: Record<string, string>) => void = vi.fn(),
) {
  return render(
    createElement(AskUserQuestionPrompt, {
      sessionId: 'ask-actions',
      pending,
      onAnswer,
      viewerState: 'expanded',
      onViewerStateChange: () => {},
      draft: null,
      onDraftChange: () => {},
    }),
  );
}

describe('AskUserQuestionPrompt action labels', () => {
  // Unit regression: the existing answer tests never opened evidence in a title.
  // Minimal input: a bare HTML filename + URL. The real prompt/resolver must
  // open the correct origin without answering, and preserve the original answer key.
  it.each([null, 'ssh-host'])('opens verified question evidence for origin %s without answering', async (remoteHostId) => {
    _clearSmartResolveCache();
    links.html.mockClear();
    links.url.mockImplementation((event) => event.preventDefault());
    const resolvePathBatch = vi.fn(async ({ hrefs }: { hrefs: string[] }) => Object.fromEntries(hrefs.map((href) => [href,
      href === 'sidebar-layout-v1.html'
        ? { status: 'unique', candidates: ['/repo/sidebar-layout-v1.html'], kind: 'file' }
        : { status: 'none', candidates: [] },
    ])));
    const chatStat = vi.fn(async ({ absPath }: { absPath: string }) => ({
      verdict: absPath.endsWith('missing.html') ? 'nonfile' : 'file',
    }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { resolvePathBatch, fileBrowser: { chatStat } } });
    const question = '请查看 sidebar-layout-v1.html 或 https://example.com/view。 missing.html';
    const onAnswer = vi.fn();
    const view = render(createElement(AskUserQuestionPrompt, {
      sessionId: 'evidence', workingDir: '/repo', remoteHostId,
      pending: { requestId: 'review', questions: [{ question, options: [{ label: 'Accept' }] }] },
      onAnswer, viewerState: 'expanded', onViewerStateChange: vi.fn(), draft: null, onDraftChange: vi.fn(),
    }));
    const file = await view.findByRole('link', { name: 'sidebar-layout-v1.html' });
    fireEvent.click(file);
    fireEvent.keyDown(file, { key: 'Enter' });
    expect(links.html).toHaveBeenCalledWith('evidence', '/repo/sidebar-layout-v1.html', expect.any(Function),
      expect.objectContaining({ workingDir: '/repo', origin: remoteHostId ? { kind: 'ssh', remoteHostId } : { kind: 'local' } }));
    fireEvent.click(view.getByRole('link', { name: 'https://example.com/view' }));
    expect(links.url).toHaveBeenCalledWith(expect.anything(), 'evidence', 'https://example.com/view', expect.any(Function));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(view.queryByRole('link', { name: 'missing.html' })).toBeNull();
    if (remoteHostId) expect(resolvePathBatch).not.toHaveBeenCalled();
    fireEvent.click(view.getByText('Accept'));
    expect(onAnswer).toHaveBeenCalledWith('review', { [question]: 'Accept' });
  });
  it('distinguishes updating an answer from keeping it when revisiting a middle question', async () => {
    const view = renderAskUser({
      requestId: 'req-revisit',
      questions: [
        { question: 'First question', options: [{ label: 'A' }] },
        { question: 'Second question', options: [{ label: 'B' }] },
      ],
    });

    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Custom answer' },
    });
    expect((view.getByTestId('ask-user-custom-next') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(view.getByTestId('ask-user-custom-next'));
    await waitFor(() => expect(view.queryByText('Second question')).not.toBeNull());
    await waitFor(() => expect(view.queryByRole('button', { name: /Back/ })).not.toBeNull());

    fireEvent.click(view.getByRole('button', { name: /Back/ }));
    await waitFor(() => expect(view.queryByText('First question')).not.toBeNull());
    await waitFor(() => expect(view.queryByTestId('ask-user-custom-next')).not.toBeNull());

    expect((view.getByTestId('ask-user-custom-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses Submit for a custom answer on the final question without a footer duplicate', () => {
    const onAnswer = vi.fn();
    const view = renderAskUser(
      {
        requestId: 'req-submit',
        questions: [{ question: 'Final question', options: [{ label: 'A' }] }],
      },
      onAnswer,
    );

    fireEvent.click(view.getByText('Type something else…'));
    fireEvent.change(view.getByPlaceholderText('Type your answer…'), {
      target: { value: 'Updated answer' },
    });
    expect(view.getAllByRole('button', { name: 'Submit' })).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Submit' }));

    expect(onAnswer).toHaveBeenCalledWith('req-submit', {
      'Final question': 'Updated answer',
    });
  });

  it('does not show an inert footer Submit for an unanswered final single-select question', () => {
    const view = renderAskUser({
      requestId: 'req-final-unanswered',
      questions: [{ question: 'Final question', options: [{ label: 'A' }] }],
    });

    expect(view.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('keeps the footer Submit for a final multi-select question', () => {
    const onAnswer = vi.fn();
    const view = renderAskUser(
      {
        requestId: 'req-final-multi-select',
        questions: [
          {
            question: 'Final multi-select question',
            multiSelect: true,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
      onAnswer,
    );

    const submit = view.getByRole('button', { name: 'Submit' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(view.getByText('A'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(onAnswer).toHaveBeenCalledWith('req-final-multi-select', {
      'Final multi-select question': '["A"]',
    });
  });

  it('provides localized prompt copy in every supported locale', () => {
    const expected = {
      en: ['Next', 'Submit'],
      'zh-CN': ['下一题', '提交'],
      'zh-TW': ['下一題', '提交'],
      ja: ['次へ', '送信'],
      ko: ['다음', '제출'],
    } as const;

    for (const [locale, labels] of Object.entries(expected)) {
      expect(i18n.t('chat.askUserQuestion.next', { lng: locale })).toBe(labels[0]);
      expect(i18n.t('chat.askUserQuestion.submit', { lng: locale })).toBe(labels[1]);
      expect(i18n.t('chat.askUserQuestion.customAnswer', { lng: locale })).not.toBe(
        'chat.askUserQuestion.customAnswer',
      );
      expect(i18n.t('chat.askUserQuestion.answerPlaceholder', { lng: locale })).not.toBe(
        'chat.askUserQuestion.answerPlaceholder',
      );
    }
  });
});
