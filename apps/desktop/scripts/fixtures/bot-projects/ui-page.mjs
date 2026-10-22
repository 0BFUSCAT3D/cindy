import assert from 'node:assert/strict';
export default {
  name: 'bot-projects', entry: './projects-fixture.tsx', viewport: { width: 460, height: 540 },
  real: 'BotProjectsSettings, project list, selection, add/remove, error recovery and standard controls',
  notCovered: 'Account persistence, actual file reads and remote-device transport; local persistence also tested in the full isolated Desktop.',
  cases: {
    default: { about: 'Add a second project and remove it without changing the first' },
    empty: { about: 'Start with no links; selection and add are separate actions' },
    legacy: { about: 'Preserve foreign computer and missing project associations' },
    error: { about: 'Recover from an unavailable list without treating it as empty' },
  },
  async ready(page) { await page.getByRole('combobox').or(page.getByRole('alert')).first().waitFor(); },
  async check(page, ui) {
    if (ui.case === 'error') {
      await page.getByRole('button', { name: await ui.t('bots.memory.useLatest'), exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
    }
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Filo · 移动端与协作体验', exact: true }).click();
    await page.getByRole('button', { name: await ui.t('bots.projects.add'), exact: true }).click();
    const remove = page.getByRole('button', { name: await ui.t('bots.projects.remove', { name: 'Filo · 移动端与协作体验' }), exact: true });
    await remove.waitFor();
    await ui.capture('added');
    await remove.click();
    await remove.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alert').count(), 0);
  },
};
