import { useState } from 'react';
import { PanelRight, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useMatch, useNavigate } from 'react-router-dom';

import { useGhostMainViews, type GhostMainViewItem } from '@/cindy-brain/ghostMainViews';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { addGlobalPluginTab, setActiveGlobalTabId } from '@/features/right-sidebar/globalTabs';
import { requestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { cn } from '@/lib/utils';

import { SIDEBAR_RAIL_ICON_BUTTON_CLASS } from './SidebarIconButton';
import { Tip } from '../ui/tooltip';

const ROW_CLASS =
  'flex h-8 w-full items-center gap-2.5 rounded-full px-3 text-sm font-normal text-[var(--sidebar-nav-text)] transition-colors hover:bg-sidebar-item-hover';
const ROW_ACTIVE_CLASS =
  'bg-sidebar-item-active font-medium text-sidebar-item-active-foreground shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)] hover:bg-sidebar-item-active';
const RAIL_ACTIVE_CLASS =
  '[--button-face-bg:var(--chat-input-chip-bg)] text-[var(--msg-assistant-text)] enabled:hover:[--button-face-bg:var(--chat-input-chip-bg)] enabled:active:[--button-face-bg:var(--chat-input-chip-bg)]';

export { MAIN_VIEW_ICONS } from '@/cindy-brain/mainViewIcons';
import { MAIN_VIEW_ICONS } from '@/cindy-brain/mainViewIcons';

/** Expanded and rail variants consume the exact same sorted visibility projection. */
export function GhostMainViewNavEntries({ variant }: { variant: 'row' | 'rail' }) {
  const { sidebarVisible } = useGhostMainViews();
  return sidebarVisible.map((item) => (
    <GhostMainViewNavEntry key={item.instanceId} item={item} variant={variant} />
  ));
}

/** One plugin main-view entry; the sidebar navigation places it in the saved order. */
export function GhostMainViewNavEntry({
  item,
  variant,
}: {
  item: GhostMainViewItem;
  variant: 'row' | 'rail';
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const activeMatch = useMatch('/apps/:ghostId');
  const active = activeMatch?.params.ghostId === item.instanceId;
  const Icon = MAIN_VIEW_ICONS[item.icon];
  const icon = (
    <Icon
      aria-hidden="true"
      size={variant === 'row' ? 15 : 18}
      strokeWidth={1.8}
      className="shrink-0"
    />
  );
  const open = () => navigate(`/apps/${encodeURIComponent(item.instanceId)}`);
  const openDetails = () =>
    navigate(`/settings?tab=ghosts&ghost=${encodeURIComponent(item.instanceId)}`);
  // 右键菜单:「在侧边栏中打开」= 把这个插件视图作为全局页签(不跟对话)钉进右侧栏。
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
  };
  const openInSidebar = () => {
    const tab = addGlobalPluginTab(item.instanceId);
    if (!tab) return;
    setActiveGlobalTabId(tab.id);
    requestRightSidebarVisibility('open');
  };
  const contextMenu = (
    <DropdownMenu
      open={contextMenuPos !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) setContextMenuPos(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: contextMenuPos?.x ?? 0,
            top: contextMenuPos?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={2}>
        <DropdownMenuItem
          onClick={() => {
            setContextMenuPos(null);
            openInSidebar();
          }}
        >
          <PanelRight size={14} aria-hidden="true" />
          {t('ghostMainView.openInSidebar')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (variant === 'rail') {
    return (
      <>
        <Tip text={item.title} side="right">
          <button
            type="button"
            aria-label={item.title}
            aria-current={active ? 'page' : undefined}
            onClick={open}
            onContextMenu={onContextMenu}
            className={cn(SIDEBAR_RAIL_ICON_BUTTON_CLASS, active && RAIL_ACTIVE_CLASS)}
          >
            {icon}
          </button>
        </Tip>
        {contextMenu}
      </>
    );
  }

  return (
    <div
      className={cn(ROW_CLASS, 'group/main-view gap-0 px-0', active && ROW_ACTIVE_CLASS)}
      onContextMenu={onContextMenu}
    >
      {contextMenu}
      <button
        type="button"
        aria-label={item.title}
        title={item.title}
        data-native-title="truncated-text"
        aria-current={active ? 'page' : undefined}
        onClick={open}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-full pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {icon}
        <span className="min-w-0 truncate leading-none">{item.title}</span>
      </button>
      <Tip text={t('settings.ghosts.page.manageAria', { name: item.manifest.name })} side="right">
        <button
          type="button"
          onClick={openDetails}
          aria-label={t('settings.ghosts.page.manageAria', { name: item.manifest.name })}
          className={cn(
            'pointer-events-none mr-1.5 grid size-6 shrink-0 place-items-center rounded-full opacity-0 transition-[background-color,color,opacity] duration-150 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] group-hover/main-view:pointer-events-auto group-hover/main-view:opacity-100 group-focus-within/main-view:pointer-events-auto group-focus-within/main-view:opacity-100',
            active
              ? 'text-sidebar-item-active-foreground hover:bg-[var(--sidebar-item-active-border)] hover:text-sidebar-item-active-foreground'
              : 'text-[var(--sidebar-nav-text)] hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)]',
          )}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
