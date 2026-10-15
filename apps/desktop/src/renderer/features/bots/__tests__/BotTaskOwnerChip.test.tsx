// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { BotTaskOwnerChip } from '../BotTaskOwnerChip';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), ensure: vi.fn(), profiles: [] as unknown[] }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}:${JSON.stringify(options)}` }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../BotAvatar', () => ({ BotAvatar: ({ bot }: any) => <span data-avatar={bot.name} /> }));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  ensureBotProfilesLoaded: mocks.ensure,
}));

const profile = {
  id: 'bot/a',
  name: 'LiZi',
  sessions: [
    { id: 'main', role: 'canonical', kind: 'chat' },
    { id: 'task', role: 'delegation', kind: 'worker' },
    { id: 'old', role: 'history', kind: 'history' },
  ],
};
beforeEach(() => {
  mocks.profiles = [profile];
  mocks.ensure.mockReset().mockResolvedValue([]);
  mocks.navigate.mockReset();
});
afterEach(cleanup);

it("names a Bot's background task in its ordinary header and leads back to that Bot", () => {
  render(<BotTaskOwnerChip sessionId="task" />);
  expect(mocks.ensure).toHaveBeenCalledTimes(1);
  expect(screen.getByText('bots.session.ownedByBot:{"name":"LiZi"}')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.session.backToBot:{"name":"LiZi"}' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot%2Fa');
});

it.each(['main', 'old', 'plain'])('stays out of the way for %s', (sessionId) => {
  const { container } = render(<BotTaskOwnerChip sessionId={sessionId} />);
  expect(container.firstChild).toBeNull();
});

it('is mounted next to the ordinary task title', () => {
  const header = readFileSync(resolve(__dirname, '../../cc-agent/SessionContentHeader.tsx'), 'utf8');
  expect(header).toContain('{!isEditing && <BotTaskOwnerChip sessionId={session.id} />}');
});
