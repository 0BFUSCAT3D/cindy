// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeammateSearchResults, useTeammateSearchMatches } from '../TeammateSearchResults';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  remoteBots: [] as unknown[],
  groups: [] as unknown[],
  navigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));
vi.mock('../botGroupStore', () => ({ useBotGroupList: () => ({ groups: mocks.groups }) }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="avatar" /> }));

function bot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, description: '', skills: [], status: 'active', sessions: [], createdAt: 1, ...extra };
}

beforeEach(() => {
  mocks.profiles = [
    bot('steward', 'PR steward', { skills: ['web-research'] }),
    bot('hidden', 'Hidden release steward', { hiddenAt: 2 }),
    bot('stopped', 'Stopped release', { status: 'archived' }),
    bot('writer', 'Writer', { description: '写周报' }),
  ];
  mocks.remoteBots = [
    { id: 'cloud', deviceId: 'mac-mini', deviceName: 'Mac mini', name: 'Cloud helper', description: '', activityAt: 1 },
  ];
  mocks.groups = [
    { id: 'trip', name: '周末出游', members: [{ botId: 'mimi', name: '咪咪', avatar: '', avatarColor: '' }] },
  ];
});
afterEach(() => {
  cleanup();
  mocks.navigate.mockReset();
});

const names = (query: string) =>
  renderHook(() => useTeammateSearchMatches(query)).result.current.map((match) => match.name);

describe('teammates in the sidebar-wide search', () => {
  it('matches nothing for an empty query', () => {
    expect(names('  ')).toEqual([]);
  });

  it('matches names, descriptions and skills, keeps hidden teammates and leaves stopped ones out', () => {
    expect(names('release')).toEqual(['Hidden release steward']);
    expect(names('WEB-RESEARCH')).toEqual(['PR steward']);
    expect(names('周报')).toEqual(['Writer']);
  });

  it('finds remote teammates by their computer and group chats by member names', () => {
    expect(names('mac mini')).toEqual(['Cloud helper']);
    expect(names('出游')).toEqual(['周末出游']);
    expect(names('咪咪')).toEqual(['周末出游']);
  });

  it('opens the chosen chat and lets the popover close itself', () => {
    const onSelected = vi.fn();
    const { result } = renderHook(() => useTeammateSearchMatches('e'));
    render(<TeammateSearchResults matches={result.current} onSelected={onSelected} />);

    fireEvent.click(screen.getByRole('button', { name: /Cloud helper/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/remote/mac-mini/cloud');
    fireEvent.click(screen.getByRole('button', { name: /Writer/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/writer');
    expect(onSelected).toHaveBeenCalledTimes(2);
  });

  it('labels group chats apart from teammates', () => {
    const { result } = renderHook(() => useTeammateSearchMatches('出游'));
    render(<TeammateSearchResults matches={result.current} />);
    fireEvent.click(screen.getByRole('button', { name: /周末出游/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/groups/trip');
    expect(screen.getByText('bots.groupChat.sidebar.title')).toBeTruthy();
  });
});
