import assert from 'node:assert/strict';

export default {
  name: 'provider-share-insights',
  entry: './provider-share-insights-fixture.tsx',
  viewport: { width: 1220, height: 900 },
  real: 'ProviderShareManagePage, ProviderShareReceivedDetail, visibility switches, quota cards, ProviderUsageSection, translations and themes',
  notCovered:
    'Live cross-account transport, persisted permissions, real upstream quota, Windows. All numbers and names are fixture data.',
  stubs: {
    'src/renderer/hooks/useProviders': {
      partial: 'export const useProviders = () => ({ providers: [], loading: false });',
    },
    'src/renderer/hooks/useDeviceProviders': {
      partial: `export const useDeviceProviders = () => ({ providers: [{ id: 'xd', name: 'Cindy AI', routing: {}, models: { 'claude-code': [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }], codex: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] } }], loading: false, error: null, unsupported: false });`,
    },
  },
  cases: {
    owner: {
      about: 'Owner detail with two independent switches; writes affect fixture memory only',
    },
    default: { about: 'Both capabilities; usage collapsed, models visible at desktop height' },
    expanded: {
      about: 'Explicitly expanded usage with charts by person and model',
      viewport: { width: 1220, height: 2100 },
    },
    subscription: { about: 'Read-only subscription windows with existing remaining bars' },
    organization: { about: 'Organization remaining balance and known budget' },
    unknown: { about: 'Unknown total has no fabricated percentage' },
    zero: { about: 'True zero balance has a zero progress bar' },
    'quota-only': { about: 'Only remaining allowance shared' },
    'usage-only': { about: 'Only usage details shared' },
    closed: { about: 'Both permissions disabled without disabling model use' },
    group: { about: 'Two anonymous own accounts; borrowed accounts excluded' },
  },
  async ready(page) {
    await page
      .getByTestId('provider-share-visibility')
      .or(page.getByTestId('provider-share-insights'))
      .waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'owner') {
      const quota = page.getByRole('switch', {
        name: await ui.t('providerShare.insights.allowQuota'),
        exact: true,
      });
      const usage = page.getByRole('switch', {
        name: await ui.t('providerShare.insights.allowUsage'),
        exact: true,
      });
      await quota.waitFor();
      const descriptionId = await usage.getAttribute('aria-describedby');
      assert.ok(descriptionId);
      const description = page.locator(`[id="${descriptionId}"]`);
      assert.equal(
        await description.textContent(),
        await ui.t('providerShare.insights.allowUsageDescription'),
      );
      assert.equal(await description.isVisible(), true);
      assert.equal(await quota.getAttribute('aria-describedby'), null);
      assert.equal(await quota.isEnabled(), true);
      await quota.click();
      assert.equal(await quota.getAttribute('aria-checked'), 'false');
      assert.equal(await usage.getAttribute('aria-checked'), 'true');
      await quota.click();
      await ui.capture('owner-switches');
    } else {
      const body = await page.getByTestId('provider-share-insights').textContent();
      assert.ok(!body.includes('Private device name'));
      const models = page.getByTestId('provider-share-received-models');
      assert.equal(await models.getByRole('listitem').count(), 3);
      if (ui.case === 'default') {
        const bounds = await models.getByRole('listitem').last().boundingBox();
        assert.ok(
          bounds && bounds.y + bounds.height <= ui.viewport.height,
          'Default view shows models without scrolling',
        );
        await ui.capture('collapsed-models');
      }
      const progress = page.getByRole('progressbar');
      if (ui.case === 'default') {
        assert.equal(await progress.count(), 3);
        assert.ok(
          Math.abs(
            Number(await progress.first().getAttribute('aria-valuenow')) - (24.8 / 60) * 100,
          ) < 0.01,
        );
      }
      if (ui.case === 'organization')
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '64.8');
      if (ui.case === 'group') assert.equal(await progress.count(), 5);
      if (ui.case === 'unknown') assert.equal(await progress.count(), 0);
      if (ui.case === 'zero')
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '0');
      if (ui.case === 'subscription') {
        assert.equal(await progress.count(), 2);
        assert.equal(await progress.first().getAttribute('aria-valuenow'), '43');
      }
      if (!['closed', 'quota-only'].includes(ui.case)) {
        const toggle = page.getByRole('button', {
          name: await ui.t('providerShare.insights.usageTitle'),
          exact: true,
        });
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        const tabs = page.getByRole('tablist', { name: await ui.t('providerGroup.usage.title') });
        assert.equal(await tabs.count(), 0);
        if (ui.case === 'expanded') {
          await toggle.click();
          await tabs.waitFor();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert.equal(await tabs.getByRole('tab').count(), 2);
          await ui.capture('by-person');
          await tabs
            .getByRole('tab', { name: await ui.t('providerGroup.usage.stack.model') })
            .click();
          assert.equal(await page.getByTestId('provider-usage-model').count(), 2);
          await ui.capture('by-model');
        }
      }
    }
  },
};
