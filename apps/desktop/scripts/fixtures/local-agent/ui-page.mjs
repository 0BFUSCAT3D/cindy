const connections = [
  { id: 'grant-notes', name: 'Notes', clientId: 'org.example.notes' },
  { id: 'grant-board', name: 'Board', clientId: 'org.example.board' },
];

export default {
  name: 'local-agent', entry: './local-agent-fixture.tsx', viewport: { width: 900, height: 650 },
  real: 'LocalAgentSection, standard settings rows and themed Button',
  notCovered: 'Native consent, IPC authentication and actual grant revocation; these require isolated Desktop and protocol integration checks.',
  cases: {
    default: { about: 'Revoke one application and retain the other row', data: { connections } },
    long: { about: 'Long unverified application names and IDs at phone width', viewport: { width: 390, height: 844 }, data: { connections: [
      { id: 'grant-long', name: 'Independent application with a long name 独立本机应用程序', clientId: 'org.example.an.independent.application.with.a.long.identifier' }, connections[1],
    ] } },
    empty: { about: 'No application is connected', data: { connections: [] } },
    'read-failed': { about: 'Connection read error remains visible', data: { loadFailed: true } },
    cancelled: { about: 'Cancelling native confirmation retains both applications', data: { connections, cancel: true } },
    'revoke-failed': { about: 'Failed revocation retains both applications and offers retry', data: { connections, revokeFailed: true } },
  },
  async check(page, ui) {
    const heading = page.getByRole('heading', { name: await ui.t('localAgent.title') });
    await heading.waitFor();
    const list = ui.data.connections ?? [];
    if (!list.length) {
      await page.getByText(await ui.t(ui.data.loadFailed ? 'localAgent.failed' : 'localAgent.empty'), { exact: true }).waitFor();
      return;
    }
    await page.getByText(list[0].clientId, { exact: false }).waitFor();
    await page.getByRole('button', { name: await ui.t('localAgent.revokeConnection', { app: list[0].name }), exact: true }).click();
    if (ui.data.cancel || ui.data.revokeFailed) await page.getByText(list[0].clientId, { exact: false }).waitFor();
    else await page.getByText(list[0].clientId, { exact: false }).waitFor({ state: 'detached' });
    await page.getByText(list[1].clientId, { exact: false }).waitFor();
  },
};
