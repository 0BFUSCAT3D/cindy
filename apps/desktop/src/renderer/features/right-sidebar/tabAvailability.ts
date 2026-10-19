import type { InstalledGhost } from '../../../shared/ghost';
import { CINDY_MAKE_ENABLED } from '@cindy/maker-shared/cindy-make-feature';
import { FEATURE_RETIREMENTS } from '../../../shared/featureRetirements';
import type { TabState } from './types';

export interface RightSidebarTabAvailability {
  installedGhosts: readonly InstalledGhost[];
  subagentsAvailable: boolean;
  /**
   * 已弹出到独立窗口的页签:数据仍在桶里,但本 Shell 不投影、不挂 body,其
   * 窗口关闭后再回到投影。缺省 = 没有弹出。
   */
  hiddenTabIds?: ReadonlySet<string>;
}

function retiredTab(
  tab: TabState,
  availability: RightSidebarTabAvailability,
): TabState | null | undefined {
  const descriptor = FEATURE_RETIREMENTS.find((entry) =>
    entry.source.sidebarKinds?.includes(tab.kind),
  );
  if (!descriptor) return undefined;
  const source = availability.installedGhosts.find(
    (ghost) => ghost.retirement?.id === descriptor.id,
  );
  return source
    ? {
        ...tab,
        kind: 'retired-feature',
        state: { retirementId: descriptor.id, pluginId: source.manifest.id },
      }
    : null;
}

function isUnavailableTab(tab: TabState, availability: RightSidebarTabAvailability): boolean {
  return (
    availability.hiddenTabIds?.has(tab.id) === true ||
    (!CINDY_MAKE_ENABLED && tab.kind === 'cindy-make') ||
    retiredTab(tab, availability) === null ||
    (tab.kind === 'subagents' && !availability.subagentsAvailable)
  );
}

/** Legacy persisted tabs become host notices, never load the removed implementation. */
export function projectAvailableTabs(
  tabs: readonly TabState[],
  activeTabId: string | null,
  availability: RightSidebarTabAvailability,
): { tabs: TabState[]; activeTabId: string | null } {
  const visibleTabs = tabs
    .filter((tab) => !isUnavailableTab(tab, availability))
    .map((tab) => retiredTab(tab, availability) ?? tab);
  return {
    tabs: visibleTabs,
    activeTabId: visibleTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (visibleTabs[0]?.id ?? null),
  };
}

/** Preserve unavailable slots when reordering visible tabs. */
export function mergeAvailableTabOrder(
  allTabs: readonly TabState[],
  orderedVisibleIds: readonly string[],
  availability: RightSidebarTabAvailability,
): string[] {
  const visibleTabs = allTabs.filter((tab) => !isUnavailableTab(tab, availability));
  const expectedIds = new Set(visibleTabs.map((tab) => tab.id));
  if (
    orderedVisibleIds.length !== visibleTabs.length ||
    new Set(orderedVisibleIds).size !== orderedVisibleIds.length ||
    orderedVisibleIds.some((id) => !expectedIds.has(id))
  )
    return allTabs.map((tab) => tab.id);
  let index = 0;
  return allTabs.map((tab) =>
    isUnavailableTab(tab, availability) ? tab.id : (orderedVisibleIds[index++] ?? tab.id),
  );
}
