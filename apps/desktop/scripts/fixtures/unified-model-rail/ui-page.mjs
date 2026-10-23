export default {
  name: 'unified-model-rail',
  entry: './unified-model-rail-fixture.tsx',
  viewport: { width: 780, height: 640 },
  real: 'ModelSelectorContent, UnifiedModelRail, unified list sections, recents/favorites state, themes and translations',
  notCovered: 'Account entitlement, live model calls, database persistence and native mobile controls',
  cases: {
    default: { about: '「全部」视图:联合列表 + 侧栏 rail 全格' },
    recent: { about: '「最近」视图:三态 Fast 载体(`ultrafast`/`true`)的条目后缀原样保留' },
  },
  async check(page, ui) {
    await page.getByRole('listbox', { name: await ui.t('newChat.modelSelector.modelListAria') }).waitFor();
    if (ui.case === 'default') {
      await ui.capture('all-view');
      return;
    }
    // 切到「最近」格:三条最近使用,其中 GPT-5.6(codex) 带 Ultrafast、GPT-5.6(cc) 带 Fast。
    await page.getByRole('button', { name: await ui.t('newChat.modelSelector.unified.railRecent'), exact: true }).click();
    await page.getByText('GPT-5.6').first().waitFor();
    await ui.capture('recent-view');
  },
};
