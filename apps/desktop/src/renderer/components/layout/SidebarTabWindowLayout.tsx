/**
 * SidebarTabWindowLayout —— 右侧栏单页签独立窗口的根组件。
 *
 * 窗口由 main/sidebar-tab-window/window.ts 打开(`?sidebarWindow=1&sidebarTabWindow=1`),
 * 由 sidebar-window-entry.tsx 分流进来。本组件:
 *   - 等 main 指派页签(预热的 spare 窗口在壳挂载后才收到指派;重载时主动
 *     getAssignment 拿回):登记 soloTabId、导入不可持久化会话的内存快照,再把
 *     会话交给 RightSidebarShell(soloTabId 形态:只投影 / 挂载这一个页签)。
 *   - 双阶段就绪握手:mount → rendererReady;被指派页签所在桶水合且页签在场 →
 *     presentationReady,main 这时才 show。
 *   - 46px 自绘 chrome:整条 drag region;mac 左端红绿灯让位、win 右端 WindowControls
 *     (close = 合并回侧边栏);中部页签图标 + 标题(复用插件的 TabPillIcon /
 *     TabPillTitle);右端「合并回侧边栏」按钮。
 *   - 「合并回侧边栏」(按钮 / 协同页签「在主窗查看」):不可持久化会话附本页签内存态,
 *     main 销毁窗口并把页签交回主窗。
 *   - 关窗 = 关闭页签(⌘W / 红绿灯 / Windows X / 原生关窗请求):走 store.closeTab,
 *     与侧边栏里关页签同一流程(插件 onBeforeClose、确认拦截照常,被否决则窗口留着)。
 *   - 页签从桶里消失(上面的关闭 / guest 自关 / agent close):通知 main 销毁窗口
 *     (不交回)。
 *   - 显隐推送:隐藏时模糊焦点、重挂 chrome(复用隐藏窗口不继承上次 hover 态)。
 *
 * 与 SidebarWindowLayout 一样挂 useDeviceLinkRemoteProjects / makerChatStore 监听:
 * device-link 远程会话镜像是每个 renderer 一份,协同 / 后台任务等页签靠它路由。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { PanelRight } from 'lucide-react';

import { RightSidebarShell } from '@/features/right-sidebar/RightSidebarShell';
import { ToastContainer } from '@/components/ui/toast';
import { useDeviceLinkRemoteProjects } from '@/features/device-link/useDeviceLinkRemoteProjects';
import { mergeSidebarWindowBack } from '@/features/right-sidebar/lib/mergeSidebarWindowBack';
import { setSoloTabId } from '@/features/right-sidebar/lib/tabHosting';
import { getTabKind, hydrateTabState } from '@/features/right-sidebar/registry';
import { closeTab, getBucket, importTabSnapshot, subscribe } from '@/features/right-sidebar/store';
import { iconForTabKind, labelKeyForTabKind } from '@/features/right-sidebar/TabBar';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { useLocale } from '@/hooks/useLocale';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import { ensureGhostPanelsRegistered, useGhostPanelsSync } from '@/cindy-brain/ghostPanels';
import type { SidebarTabWindowOpenRequest } from '../../../shared/sidebarTabWindow';

const log = createLogger('SidebarTabWindowLayout');

export function SidebarTabWindowLayout() {
  const { t } = useTranslation();
  const { effectiveLocale, setLocale } = useLocale();
  ensureGhostPanelsRegistered();
  useGhostPanelsSync();
  useEffect(() => {
    // 弹出窗口需要实时事件维护页签内容,但认证失败后的凭证读取、会话重启与消息重发
    // 必须只由主 renderer 执行。
    makerChatStore.initGlobalListeners({ ownsRemoteAuthRetry: false, ownsRemoteListCache: false });
  }, []);
  const isMac = window.electronAPI?.platform === 'darwin';
  const api = window.electronAPI?.sidebarTabWindow;
  const [assignment, setAssignment] = useState<SidebarTabWindowOpenRequest | null>(null);
  const [windowVisible, setWindowVisible] = useState(false);
  useDeviceLinkRemoteProjects(windowVisible, 'sidebar');
  const presentationReadySentRef = useRef(false);
  const leavingRef = useRef(false);
  const [windowChromeRevision, setWindowChromeRevision] = useState(0);

  const applyAssignment = useCallback((next: SidebarTabWindowOpenRequest) => {
    setAssignment((prev) => {
      if (prev?.tabId === next.tabId && prev.sessionId === next.sessionId) return prev;
      // 必须早于 Shell 的 ensureHydrated:不可持久化会话只能从这份快照水合。
      if (next.handoff) importTabSnapshot(next.handoff);
      setSoloTabId(next.tabId);
      leavingRef.current = false;
      presentationReadySentRef.current = false;
      return next;
    });
  }, []);

  // mount:订阅指派推送 + 主动拉一次(重载 / 推送早于订阅)+ renderer-ready 握手。
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const offAssigned = api.onAssigned?.((next) => {
      if (!cancelled) applyAssignment(next);
    });
    void api
      .getAssignment?.()
      .then((next) => {
        if (!cancelled && next) applyAssignment(next);
      })
      .catch((err) => log.warn('getAssignment failed', err));
    void api.rendererReady?.().catch((err) => {
      log.warn('renderer-ready handshake failed', err);
    });
    return () => {
      cancelled = true;
      offAssigned?.();
    };
  }, [api, applyAssignment]);

  useEffect(() => {
    return (
      api?.onLocaleChanged?.((locale) => {
        if (locale !== effectiveLocale) setLocale(locale);
      }) ?? undefined
    );
  }, [api, effectiveLocale, setLocale]);

  // 显隐:隐藏时模糊焦点 + 重挂 chrome;显示时同样先模糊,避免继承旧焦点。
  useEffect(() => {
    return (
      api?.onVisibilityChanged?.((payload) => {
        setWindowVisible(payload.visible);
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (!payload.visible) setWindowChromeRevision((revision) => revision + 1);
      }) ?? undefined
    );
  }, [api]);

  const sessionId = assignment?.sessionId ?? null;
  const tabId = assignment?.tabId ?? null;
  const subscribeBucket = useCallback(
    (onChange: () => void) =>
      subscribe((changedSessionId) => {
        if (changedSessionId === sessionId) onChange();
      }),
    [sessionId],
  );
  const getBucketSnapshot = useCallback(() => getBucket(sessionId), [sessionId]);
  const bucket = useSyncExternalStore(subscribeBucket, getBucketSnapshot);
  const tab = useMemo(
    () => (tabId ? (bucket.tabs.find((candidate) => candidate.id === tabId) ?? null) : null),
    [bucket.tabs, tabId],
  );

  // presentation-ready:被指派页签的桶已水合且页签在场 → main 可以展示窗口。
  useEffect(() => {
    if (presentationReadySentRef.current || !assignment || !bucket.hydrated || !tab) return;
    presentationReadySentRef.current = true;
    void api?.presentationReady?.().catch((err) => {
      log.warn('presentation-ready handshake failed', err);
    });
  }, [api, assignment, bucket.hydrated, tab]);

  // 页签已不在桶里(本窗口内被关闭):销毁本窗口,不交回。
  useEffect(() => {
    if (!assignment || !bucket.hydrated || tab || leavingRef.current) return;
    leavingRef.current = true;
    void api?.closeForTab(assignment.tabId).catch((err) => {
      leavingRef.current = false;
      log.warn('close window for closed tab failed', err);
    });
  }, [api, assignment, bucket.hydrated, tab]);

  const mergeBack = useCallback(() => {
    if (!assignment || leavingRef.current) return;
    leavingRef.current = true;
    void mergeSidebarWindowBack(assignment.sessionId).catch((err) => {
      leavingRef.current = false;
      log.warn('merge tab back failed', err);
    });
  }, [assignment]);

  // 关窗 = 关闭这个页签。closeTab 内部跑插件 onBeforeClose / 确认拦截,被否决就什么
  // 都不发生;页签真的消失后,上面的 effect 再请求 main 销毁窗口。
  const closeOwnTab = useCallback(() => {
    if (!assignment || leavingRef.current) return;
    void closeTab(assignment.sessionId, assignment.tabId).catch((err) => {
      log.warn('close popped-out tab failed', err);
    });
  }, [assignment]);

  // 原生关窗(红绿灯 / 系统关闭 / Windows X):main 拦下后转达到这里。
  useEffect(() => {
    return api?.onCloseRequested?.(() => closeOwnTab()) ?? undefined;
  }, [api, closeOwnTab]);

  // ⌘W / Ctrl+W:本窗口整个就是一个页签,与侧边栏里 ⌘W 关当前页签同义。
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    closeOwnTab();
    return true;
  });

  const plugin = tab ? getTabKind(tab.kind) : null;
  const hydratedState = tab ? hydrateTabState(plugin, tab.state) : null;
  const FallbackIcon = tab ? iconForTabKind(tab.kind) : PanelRight;
  const IconNode = plugin?.TabPillIcon;
  const TitleNode = plugin?.TabPillTitle;
  const context = assignment?.context;

  return (
    <div className="flex h-screen flex-col bg-content-area text-foreground">
      <div
        className="relative flex h-[46px] shrink-0 items-center border-b border-[var(--border-default)] bg-[var(--panel-bg)]"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className={isMac ? 'w-20 shrink-0' : 'w-3 shrink-0'} />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-[var(--text-tertiary)]">
            {tab && IconNode ? (
              <IconNode state={hydratedState} sessionId={sessionId} active />
            ) : (
              <FallbackIcon size={14} />
            )}
          </span>
          <span className="truncate text-13 text-[var(--text-secondary)]">
            {tab ? (
              TitleNode ? (
                <TitleNode state={hydratedState} sessionId={sessionId} active t={t} />
              ) : (
                t(labelKeyForTabKind(tab.kind))
              )
            ) : (
              t('rightSidebar.tabWindow.title')
            )}
          </span>
        </div>
        <div
          className="flex shrink-0 items-center gap-0.5 pr-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ChromeIconButton onClick={mergeBack} aria-label={t('rightSidebar.tabWindow.mergeBack')}>
            <PanelRight size={14} />
          </ChromeIconButton>
        </div>
        {!isMac && (
          <div
            className="flex h-full shrink-0 items-center"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <WindowControls key={windowChromeRevision} onClose={closeOwnTab} />
          </div>
        )}
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden">
        {assignment && (
          <RightSidebarShell
            sessionId={sessionId}
            workdir={context?.workdir ?? ''}
            remoteHostId={context?.remoteHostId ?? null}
            deviceLinkDeviceId={context?.deviceLinkDeviceId}
            subagentsAvailable={context?.subagentsAvailable}
            shellVisible={windowVisible}
            isMac={isMac}
            soloTabId={assignment.tabId}
          />
        )}
        {(!windowVisible || !assignment || !tab) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--panel-bg)]">
            <span className="text-13 text-[var(--text-tertiary)]">
              {assignment && bucket.hydrated && !tab
                ? t('rightSidebar.tabWindow.closed')
                : t('rightSidebar.tabWindow.loading')}
            </span>
          </div>
        )}
      </div>
      <ToastContainer />
      <GhostMediaLightboxHost
        key={windowVisible && sessionId ? sessionId : 'hidden'}
        sessionId={windowVisible && sessionId ? sessionId : undefined}
      />
    </div>
  );
}
