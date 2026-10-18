// @vitest-environment jsdom
/**
 * 启动「继续上次中断的任务」弹窗:只对仍勾选的任务发续跑指令。
 *
 * 依据:产品决策(2026-10-19)默认全选、可去掉不想继续的;没勾选的任务不得被续跑,
 * 它们的中断横幅留给用户之后单独处理。续跑复用横幅的 CONTINUE_AFTER_APP_EXIT_PROMPT。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONTINUE_AFTER_APP_EXIT_PROMPT } from '../../../../shared/interruptedTurn';
import { InterruptedTasksResumeDialog } from '../InterruptedTasksResumeDialog';

const sendUiTrigger = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: () => {} }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { sendUiTrigger } }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

describe('InterruptedTasksResumeDialog', () => {
  it('continues only the tasks that stay checked', async () => {
    const now = Date.now();
    const session = (id: string, title: string) => ({
      id,
      title,
      source: 'desktop',
      agentKind: 'cc',
      workingDir: `/code/${id}`,
      workspaceKind: 'project',
      createdAt: new Date(now).toISOString(),
    });
    Object.assign(window, {
      electronAPI: {
        localDb: {
          sessions: {
            interruptedResumeCandidates: async () => [
              { sessionId: 's-a', interruptedAt: now - 120_000, activity: '运行测试' },
              { sessionId: 's-b', interruptedAt: now - 60_000, activity: null },
            ],
            getMany: async () => [session('s-a', '任务 A'), session('s-b', '任务 B')],
          },
        },
      },
    });

    render(<InterruptedTasksResumeDialog />);

    await screen.findByRole('alertdialog');
    expect(screen.getByText('任务 A')).toBeTruthy();
    expect(screen.getByText(/s-a · 运行测试/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '任务 B' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'chat.interruptedResumeDialog.continueSelected' }),
    );

    await waitFor(() => expect(sendUiTrigger).toHaveBeenCalledTimes(1));
    expect(sendUiTrigger).toHaveBeenCalledWith('s-a', CONTINUE_AFTER_APP_EXIT_PROMPT);
  });
});
