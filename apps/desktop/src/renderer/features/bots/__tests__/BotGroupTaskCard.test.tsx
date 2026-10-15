// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupTaskCardView } from '../../../../shared/botGroupChat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.replace('bots.groupChat.task.state.', 'state:') }),
}));
// Another owner's task never reaches the live link; the component must not need its stores.
vi.mock('../BotSessionTaskLink', () => ({ BotSessionTaskLink: () => <span data-testid="live-link">live</span> }));

import { BotGroupTaskCard } from '../BotGroupTaskCard';

const task = (state: BotGroupTaskCardView['state'], summary?: string): BotGroupTaskCardView => ({
  meta: { v: 1, role: 'delegation-request', delegationId: 'task-1', fromBotId: 'bot-a', fromBotName: 'LiZi', toBotId: null,
    toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-1', objective: 'Write the launch post' },
  state, title: 'Launch post', ...(summary ? { summary } : {}),
});

afterEach(cleanup);

describe('BotGroupTaskCard', () => {
  it('shows another owner\'s task as the posted snapshot: title and state', () => {
    render(<BotGroupTaskCard task={task('completed')} owned={false} />);
    const card = screen.getByTestId('bot-group-task');
    expect(card.dataset.state).toBe('completed');
    expect(card.textContent).toContain('Launch post');
    expect(card.textContent).toContain('state:completed');
    expect(screen.queryByTestId('live-link')).toBeNull();
  });

  it('shows what a waiting task asks for', () => {
    render(<BotGroupTaskCard task={task('waiting', 'Which audience?')} owned={false} />);
    expect(screen.getByTestId('bot-group-task').textContent).toContain('state:waiting · Which audience?');
  });

  it('shows my own teammate\'s task as the live link', () => {
    render(<BotGroupTaskCard task={task('started')} owned />);
    expect(screen.getByTestId('live-link')).toBeTruthy();
    expect(screen.getByTestId('bot-group-task').textContent).toContain('state:started');
  });
});
