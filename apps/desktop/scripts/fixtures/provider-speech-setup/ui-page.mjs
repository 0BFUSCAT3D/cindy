import assert from 'node:assert/strict';
export default {
  name: 'provider-speech-setup',
  entry: './provider-speech-setup-fixture.tsx',
  viewport: { width: 1120, height: 820 },
  real: 'AddProviderWizard, UnifiedModelList toolbar, AddSpeechModelsDialog, SpeechModelChoices, model Registry resolution, translations and themes',
  notCovered:
    'Live credentials, provider network calls, OS safe storage, Settings owner changes, OAuth login and actual synthesis; host catalog/save responses are scenario data',
  cases: {
    default: { about: 'Existing API-key connection adds speech without replacing its chat model' },
    minimax: {
      about:
        'Single add-provider flow: MiniMax API key, grouped chat/speech, recommended speech default',
    },
    elevenlabs: { about: 'ElevenLabs catalog discovery, TTS-only connection' },
    bailian: { about: 'Alibaba Cloud speech recommendations visible above 100 discovered chat models' },
    subscription: { about: 'Existing OpenAI subscription creates a separate API-key connection' },
  },
  async ready(page) {
    await page.getByTestId('provider-model-toolbar').waitFor();
  },
  async check(page, ui) {
    if (['default', 'subscription'].includes(ui.case)) {
      await page
        .getByRole('button', {
          name: await ui.t('settings.providers.speechSetup.add'),
          exact: true,
        })
        .click();
    } else {
      await page.getByTestId('add-provider').click();
      await ui.capture('single-add-entry');
      const name =
        ui.case === 'minimax' ? /MiniMax/ : ui.case === 'elevenlabs' ? /ElevenLabs/ : /API/;
      const buttons = page.getByRole('dialog').getByRole('button').filter({ hasText: name });
      await buttons.first().click();
      if (ui.case === 'minimax')
        await page
          .getByRole('button', { name: await ui.t('settings.providers.wizard.useApiKey') })
          .click();
    }
    if (ui.case !== 'default') {
      if (ui.case === 'subscription')
        await page.getByText(await ui.t('settings.providers.speechSetup.separateKey')).waitFor();
      await page.getByPlaceholder('sk-…').fill('fixture-key');
      await ui.capture('connection');
      await page
        .getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true })
        .click();
    }
    const recommendedId =
      ui.case === 'elevenlabs'
        ? 'eleven_flash_v2_5'
        : ui.case === 'bailian'
          ? 'cosyvoice-v3-flash'
          : ui.case === 'subscription'
            ? 'gpt-4o-mini-tts'
            : 'speech-2.8-turbo';
    const recommended = page.getByRole('checkbox', { name: new RegExp(recommendedId) });
    await recommended.waitFor();
    assert.equal(await recommended.getAttribute('aria-checked'), 'true');
    if (ui.case === 'bailian') {
      // PR #6768: first-screen discoverability, before any test-induced scrolling.
      const box = await recommended.boundingBox();
      const height = await page.evaluate(() => window.innerHeight);
      assert.ok(box && box.y >= 0 && box.y + box.height < height);
    }
    await recommended.scrollIntoViewIfNeeded();
    await ui.capture('models');
    const finish =
      ui.case === 'default'
        ? 'settings.providers.wizard.addManualModel'
        : 'settings.providers.wizard.finish';
    await page.getByRole('button', { name: await ui.t(finish), exact: true }).click();
    await page.getByTestId('saved').waitFor();
    assert.ok((await page.getByTestId('saved').textContent()).includes(recommendedId));
    if (ui.case === 'default')
      assert.ok((await page.getByTestId('saved').textContent()).includes('MiniMax-M3'));
    await ui.capture('saved');
  },
};
