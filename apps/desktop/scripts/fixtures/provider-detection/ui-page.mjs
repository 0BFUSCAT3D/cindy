import assert from 'node:assert/strict';
export default {
  name: 'provider-detection', entry: './provider-detection-fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'ProviderConnectionDialog and AddProviderWizard, delayed handoff, model selection, translations and themes',
  notCovered: 'Network/IPC logic has separate injected production-unit tests. Live credentials, persistence integration and actual harness calls are not covered here. Windows platform is simulated when requested.',
  cases: {
    empty: { about: 'HTML design: one default connection, collapsed manual entry and bottom actions' },
    return: { about: 'Return from the identified wizard with inputs preserved and no automatic navigation' },
    default: { about: 'Official address matches DeepSeek and enters its existing connection step' },
    litellm: { about: 'LiteLLM maps to its existing provider connection' },
    'manual-fetch': { about: 'Unidentified endpoint has no cached list; user explicitly fetches models' },
    relay: { about: 'Identified Sub2API deployment keeps its own URL and key' },
    custom: { about: 'Unknown deployment retains discovered models and opens the full picker' },
    failed: { about: 'Unknown deployment with failed discovery permits manual addition' },
  },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    if (ui.case === 'empty') {
      assert.equal(await page.getByRole('tablist').count(), 0);
      assert.equal(await page.getByLabel(await ui.t('settings.providers.connection.manualId'), { exact: true }).count(), 0);
      await ui.capture('empty-add', { locator: page.getByRole('dialog') });
      return;
    }
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('我的自定义供应商');
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
    const address = ['default', 'return'].includes(ui.case) ? 'https://api.deepseek.com' : 'https://relay.example/team/v1';
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(address);
    if (['default', 'return', 'relay', 'litellm'].includes(ui.case)) {
      await page.getByRole('button', { name: await ui.t('settings.providers.detection.keepCustom') }).waitFor();
      await ui.capture('identified', { locator: page.getByRole('dialog') });
      await page.getByText(await ui.t('settings.providers.wizard.nameLabel'), { exact: true }).waitFor();
      assert.equal(await page.getByPlaceholder('sk-…').inputValue(), 'fake-ui-key');
      await ui.capture('provider-connection', { locator: page.getByRole('dialog') });
      if (ui.case === 'return') {
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.back'), exact: true }).click();
        await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).waitFor();
        await page.waitForTimeout(1800);
        await ui.capture('returned-custom', { locator: page.getByRole('dialog') });
        return;
      }
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true }).waitFor();
      await ui.capture('models', { locator: page.getByRole('dialog') });
    } else {
      await page.getByText(await ui.t('settings.providers.detection.custom'), { exact: true }).waitFor();
      if (['custom', 'manual-fetch'].includes(ui.case)) {
        await ui.capture('custom-model-list', { locator: page.getByRole('dialog') });
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.fetch.button'), exact: true }).scrollIntoViewIfNeeded();
        await ui.capture('custom-bottom', { locator: page.getByRole('dialog') });
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.fetch.button'), exact: true }).click();
        await page.getByText('example-chat', { exact: true }).last().waitFor();
        await ui.capture('model-picker');
      } else {
        await page.getByRole('button', { name: await ui.t('settings.providers.connection.manualAdd'), exact: true }).click();
        await page.getByLabel(await ui.t('settings.providers.connection.manualId'), { exact: true }).fill('private-model');
        await ui.capture('manual-fallback', { locator: page.getByRole('dialog') });
      }
    }
  },
};
