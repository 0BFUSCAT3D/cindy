export default {
  name: 'display-pricing',
  entry: './display-pricing-fixture.tsx',
  viewport: { width: 800, height: 800 },
  real: 'ModelAdvancedDrawer, UnifiedModelList, DisplayPricingDetails, localized roles, quantities, ranges and discounts',
  notCovered:
    'Live Gateway responses, account permissions and actual billing; prices are fixture inputs',
  cases: {
    speech: { about: 'Character input per million' },
    image: { about: 'Input and output per image' },
    video: { about: 'Resolution tier with discounted range and starting price' },
    default: { about: 'Multiple units, all four roles and supplementary conditions' },
    legacy: { about: 'Existing table without summary' },
    list: {
      about: 'Media list selects output first, then input',
      viewport: { width: 800, height: 600 },
    },
  },
  async check(page, ui) {
    if (ui.case === 'list') {
      const groups = page.locator('button[aria-expanded="false"]:not([aria-haspopup])');
      while (await groups.count()) await groups.first().click();
      await page.getByText('¥112', { exact: false }).waitFor();
      if (!(await page.locator('body').textContent()).includes('¥4.8–¥8'))
        throw Error('Missing discounted video summary');
    } else {
      const pricing = page.getByText(await ui.t('settings.providers.models.advanced.pricing'), {
        exact: true,
      });
      await pricing.scrollIntoViewIfNeeded();
      if (ui.case !== 'legacy') {
        const role = ['video'].includes(ui.case) ? 'output' : 'input';
        await page
          .getByText(await ui.t(`settings.providers.models.advanced.price.${role}`), {
            exact: true,
          })
          .waitFor();
      }
    }
    await ui.capture('pricing');
  },
};
