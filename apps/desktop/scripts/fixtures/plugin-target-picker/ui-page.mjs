import assert from 'node:assert/strict';

const candidates = [
  { id: 'first', label: 'Website redesign', detail: '/workspace/website' },
  { id: 'second', label: 'Review release notes', detail: '/workspace/release-notes' },
  { id: 'third', label: 'Documentation', detail: '/workspace/documentation' },
];

export default {
  name: 'plugin-target-picker',
  entry: './picker-fixture.tsx',
  viewport: { width: 760, height: 600 },
  real: 'PluginTargetPickerHost, ConfirmDialog, Input, owner push checks, translations and theme',
  notCovered: 'Real IPC, target discovery, persistent bindings, account changes, AI dispatch and attachments',
  cases: {
    default: { about: 'Choose an existing task for one delivery', data: { kind: 'task', candidates } },
    project: { about: 'Bind a project for future deliveries', data: { kind: 'project', persistent: true, candidates } },
    bot: { about: 'Choose a companion for one delivery', data: { kind: 'bot', candidates: [
      { id: 'first', label: 'Cindy', detail: 'Research and development' },
      { id: 'second', label: 'Editor', detail: 'Writing and proofreading' },
    ] } },
    empty: { about: 'No eligible local targets', data: { kind: 'task', candidates: [] } },
  },
  async ready(page) {
    await page.getByRole('alertdialog').waitFor();
  },
  async check(page, ui) {
    const dialog = page.getByRole('alertdialog');
    const action = dialog.getByRole('button', { name: await ui.t(
      ui.data.persistent ? 'pluginTargetPicker.bind' : 'pluginTargetPicker.choose'), exact: true });
    assert.equal(await action.isDisabled(), true);
    if (!ui.data.candidates.length) return;
    const rows = dialog.getByRole('group').getByRole('button');
    await rows.first().click();
    assert.equal(await action.isEnabled(), true);
    assert.equal(await rows.first().getAttribute('aria-pressed'), 'true');
    await dialog.getByRole('textbox').fill(ui.data.candidates[0].label);
    assert.equal(await rows.count(), 1);
  },
};
