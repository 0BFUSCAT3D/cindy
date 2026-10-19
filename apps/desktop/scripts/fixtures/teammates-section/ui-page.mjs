import assert from 'node:assert/strict';

const data = 'window.__uiPage.ctx.data';
const profiles = ['Cindy', 'Writer', 'Researcher', 'Designer', 'Translator', 'Reviewer'].map((name, index) => ({
  id: `mate-${index + 1}`, name, avatar: '', avatarColor: 'violet', channel: 'local',
  status: 'active', enabled: true, skills: [], capabilities: {}, createdAt: 0,
  lastMessageAt: 600 - index, lastMessagePreview: 'Ready',
  sessions: [{ id: `chat-${index}`, kind: 'chat', role: 'canonical' }],
}));

export default {
  name: 'teammates-section',
  entry: './teammates-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'TeammatesSection rows, current-chat preview, show-all/show-less controls, avatar strip, theme and translations',
  notCovered: 'Roster loading, cloud/device connections, create/delete menus and message delivery',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth=()=>({dataOwnerId:"ui-fixture"});' },
    'src/renderer/features/bots/botStore': { partial: `export const useBotProfiles=()=>${data}.profiles; export const useBotUnreadCounts=()=>({});` },
    'src/renderer/features/bots/useRemoteBots': 'export const useRemoteBots=()=>[];',
    'src/renderer/features/bots/companionCloudStore': { partial: 'const snapshot={enabled:false,actors:[],demotedBotIds:[]}; export const useCompanionCloud=()=>snapshot;' },
    'src/renderer/features/bots/botGroupStore': { partial: 'export const useBotGroupList=()=>({groups:[],loaded:true});' },
    'src/renderer/features/device-link/useDeviceLinkDeviceList': 'export const useDeviceLinkDeviceList=()=>[];',
    'src/renderer/state/agentIslandActivity': { partial: 'const activity=new Map(); export const useAgentIslandActivityMap=()=>activity;' },
    'src/renderer/features/bots/BotCreateMenu': 'export const BotCreateMenu=()=>null;',
    'src/renderer/features/bots/BotDeleteDialog': 'export const BotDeleteDialog=()=>null;',
  },
  cases: { default: { about: 'Six chats with the sixth selected; five-row preview, expand, shrink and avatar strip', data: { profiles } } },
  async check(page, ui) {
    const rows = page.getByText('Ready', { exact: true });
    assert.equal(await rows.count(), 5);
    assert.equal(await page.getByText('Translator', { exact: true }).count(), 0);
    await page.getByText('Reviewer', { exact: true }).waitFor();
    const showAllLabel = await ui.t('ccAgent.sidebar.showAllSessions', { count: 6 });
    const showAll = () => page.getByRole('button', { name: showAllLabel, exact: true });
    await showAll().click();
    assert.equal(await rows.count(), 6);
    await ui.capture('all');
    await page.getByRole('button', { name: await ui.t('bots.list.showLess'), exact: true }).click();
    assert.equal(await rows.count(), 5);
    await ui.capture('preview');
    await showAll().click();
    const header = page.getByRole('button', { name: await ui.t('bots.title'), exact: true });
    await header.click();
    await rows.first().waitFor({ state: 'hidden' });
    await ui.capture('avatars');
    await header.click();
    assert.equal(await rows.count(), 5, 'reopening the section restores its compact preview');
  },
};
