import assert from 'node:assert/strict';
export default {
  name: 'provider-detection', entry: './provider-detection-fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'ProviderConnectionDialog and AddProviderWizard, delayed handoff, model selection, translations and themes',
  notCovered: 'Network/IPC logic has separate injected production-unit tests. Live credentials, persistence integration and actual harness calls are not covered here. Windows platform is simulated when requested.',
  cases: {
    default: { about: 'Official address matches DeepSeek and enters its existing connection step' },
    relay: { about: 'Identified Sub2API deployment keeps its own URL and key' },
    custom: { about: 'Unknown deployment retains discovered models and opens the full picker' },
    failed: { about: 'Unknown deployment with failed discovery permits manual addition' },
  },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('Team connection');
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
    const address = ui.case === 'default' ? 'https://api.deepseek.com' : 'https://relay.example/team/v1';
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(address);
    if (ui.case === 'default' || ui.case === 'relay') {
      await page.getByRole('button', { name: await ui.t('settings.providers.detection.keepCustom') }).waitFor();
      await ui.capture('identified');
      await page.getByText(await ui.t('settings.providers.wizard.nameLabel'), { exact: true }).waitFor();
      assert.equal(await page.getByPlaceholder('sk-…').inputValue(), 'fake-ui-key');
      await ui.capture('provider-connection');
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true }).waitFor();
      await ui.capture('models');
    } else {
      await page.getByText(await ui.t('settings.providers.detection.custom'), { exact: true }).waitFor();
      if (ui.case === 'custom') {
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.fetch.button'), exact: true }).click();
        await page.getByText('team-chat', { exact: true }).last().waitFor();
        await ui.capture('model-picker');
      } else {
        await page.getByLabel(await ui.t('settings.providers.connection.manualModel'), { exact: true }).fill('private-model');
        await ui.capture('manual-fallback');
      }
    }
  },
};
