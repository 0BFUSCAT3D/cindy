/**
 * SidebarTabWindowLayout —— 右侧栏页签独立窗口的根组件(一扇窗 = 住在别的窗口里的页签组)。
 *
 * 窗口由 main/sidebar-tab-window/window.ts 打开(`?sidebarWindow=1&sidebarTabWindow=1`),
 * 由 sidebar-window-entry.tsx 分流进来。本组件:
 *   - 等 main 指派(预热的 spare 窗口在壳挂载后才收到指派;重载时主动 getAssignment
 *     拿回;页签加入 / 离开时 main 重发全量):登记本窗口承载的页签、导入不可持久化
 *     会话的内存快照,再把会话交给 RightSidebarShell(hostedTabIds 形态:只投影 / 挂载
 *     这些页签,页签条与「+」照常,激活位只在本窗口内存里)。
 *   - 双阶段就绪握手:mount → rendererReady;至少一个被指派页签在场 → presentationReady,
 *     main 这时才 show。
 *   - 46px 自绘 chrome 由 Shell 的合并顶栏承担:mac 左端红绿灯让位、页签条、右端
 *     「合并回侧边栏」(当前页签)+ win 端 WindowControls(close = 关闭全部页签)。
 *   - 「合并回侧边栏」(按钮 / 右键菜单 / 协同页签「在主窗查看」):按页签交回(不可持久化
 *     会话附内存态);窗口清空后 main 关窗。
 *   - 关窗 = 关闭全部页签(红绿灯 / Windows X / 原生关窗请求);⌘W = 关闭当前页签。
 *     都走 store.closeTab,与侧边栏里关页签同一流程(插件 onBeforeClose、确认拦截照常,
 *     被否决则留着)。页签从桶里消失后通知 main 从本窗口摘掉(不交回),最后一个离开即关窗。
 *   - 「+」新建的页签乐观登记为本窗口承载并请 main 收编,主窗不会把它画出来。
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
import {
  addHostedTabId,
  setHostedTabIds,
  useHostedTabIds,
} from '@/features/right-sidebar/lib/tabHosting';
import { closeTab, getBucket, importTabSnapshot, subscribe } from '@/features/right-sidebar/store';
import {
  findGlobalTab,
  isGlobalTabId,
  removeGlobalTab,
  useGlobalTabs,
} from '@/features/right-sidebar/globalTabs';
import { WindowControls } from '@/components/title-bar/WindowControls';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { useAppShortcut } from '@/hooks/useAppShortcut';
import { useCloseShortcutShellOwner } from '@/hooks/useCloseWindowShortcut';
import { useLocale } from '@/hooks/useLocale';
import { createLogger } from '@/lib/logger';
import { makerChatStore } from '@/lib/makerChatStore';
import { GhostMediaLightboxHost } from '@/cindy-brain/GhostMediaLightboxHost';
import { ensureGhostPanelsRegistered, useGhostPanelsSync } from '@/cindy-brain/ghostPanels';
import type {
  SidebarTabWindowAssignmentPayload,
  SidebarTabWindowTabRef,
} from '../../../shared/sidebarTabWindow';

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
  const [assignment, setAssignment] = useState<SidebarTabWindowAssignmentPayload | null>(null);
  const [windowVisible, setWindowVisible] = useState(false);
  useDeviceLinkRemoteProjects(windowVisible, 'sidebar');
  const presentationReadySentRef = useRef(false);
  /** 已向 main 报过「在本窗口里消失了」的页签,避免重复 close-for-tab。 */
  const reportedGoneRef = useRef(new Set<string>());
  const [windowChromeRevision, setWindowChromeRevision] = useState(0);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const applyAssignment = useCallback((next: SidebarTabWindowAssignmentPayload) => {
    // 必须早于 Shell 的 ensureHydrated:不可持久化会话只能从这份快照水合。
    if (next.handoff) importTabSnapshot(next.handoff);
    setHostedTabIds(next.tabs.map((tab) => tab.tabId));
    const stillAssigned = new Set(next.tabs.map((tab) => tab.tabId));
    for (const id of [...reportedGoneRef.current]) {
      if (!stillAssigned.has(id)) reportedGoneRef.current.delete(id);
    }
    setAssignment(next);
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
  const subscribeBucket = useCallback(
    (onChange: () => void) =>
      subscribe((changedSessionId) => {
        if (changedSessionId === sessionId) onChange();
      }),
    [sessionId],
  );
  const getBucketSnapshot = useCallback(() => getBucket(sessionId), [sessionId]);
  const bucket = useSyncExternalStore(subscribeBucket, getBucketSnapshot);
  const globalTabs = useGlobalTabs();
  const hostedTabIds = useHostedTabIds();
  // 任务桶水合后才知道任务页签在不在;只有全局页签的窗口不需要任务桶。
  const needsBucket = assignment?.tabs.some((tab) => tab.sessionId !== null) ?? false;
  const contentReady = assignment !== null && (!needsBucket || bucket.hydrated);
  const isPresent = useCallback(
    (ref: SidebarTabWindowTabRef) =>
      ref.sessionId === null
        ? globalTabs.some((tab) => tab.id === ref.tabId)
        : bucket.tabs.some((tab) => tab.id === ref.tabId),
    [bucket.tabs, globalTabs],
  );
  const presentTabs = useMemo(
    () => (assignment ? assignment.tabs.filter(isPresent) : []),
    [assignment, isPresent],
  );

  // presentation-ready:至少一个被指派页签在场 → main 可以展示窗口。
  useEffect(() => {
    if (presentationReadySentRef.current || !contentReady || presentTabs.length === 0) return;
    presentationReadySentRef.current = true;
    void api?.presentationReady?.().catch((err) => {
      log.warn('presentation-ready handshake failed', err);
    });
  }, [api, contentReady, presentTabs.length]);

  // 页签已不在桶 / 全局列表里(本窗口内被关闭 / 别处关掉):请 main 从本窗口摘掉,不交回;
  // 最后一个离开时 main 销毁窗口。
  useEffect(() => {
    if (!assignment || !contentReady) return;
    for (const ref of assignment.tabs) {
      if (isPresent(ref) || reportedGoneRef.current.has(ref.tabId)) continue;
      reportedGoneRef.current.add(ref.tabId);
      void api?.closeForTab(ref.tabId).catch((err) => {
        reportedGoneRef.current.delete(ref.tabId);
        log.warn('close-for-tab for a closed tab failed', { tabId: ref.tabId, err });
      });
    }
  }, [api, assignment, contentReady, isPresent]);

  const refFor = useCallback(
    (tabId: string) => assignment?.tabs.find((tab) => tab.tabId === tabId) ?? null,
    [assignment],
  );

  const mergeBackTab = useCallback(
    (tabId: string) => {
      const ref = refFor(tabId);
      if (!ref) return;
      void mergeSidebarWindowBack(ref.sessionId, tabId).catch((err) => {
        log.warn('merge tab back failed', { tabId, err });
      });
    },
    [refFor],
  );

  // 关页签走与侧边栏同一条流程(插件 onBeforeClose / 确认拦截);页签真的消失后,
  // 上面的 effect 再请 main 摘掉。
  const closeHostedTab = useCallback(
    async (tabId: string) => {
      const ref = refFor(tabId);
      if (!ref) return;
      if (ref.sessionId === null || isGlobalTabId(tabId)) {
        if (findGlobalTab(tabId)) removeGlobalTab(tabId);
        return;
      }
      await closeTab(ref.sessionId, tabId);
    },
    [refFor],
  );

  /** 原生关窗(红绿灯 / Windows X):关闭窗口里的全部页签;有被否决的就留着。 */
  const closeAllHostedTabs = useCallback(() => {
    if (!assignment) return;
    void (async () => {
      for (const ref of assignment.tabs) {
        try {
          await closeHostedTab(ref.tabId);
        } catch (err) {
          log.warn('close popped-out tab failed', { tabId: ref.tabId, err });
        }
      }
    })();
  }, [assignment, closeHostedTab]);

  useEffect(() => {
    return api?.onCloseRequested?.(() => closeAllHostedTabs()) ?? undefined;
  }, [api, closeAllHostedTabs]);

  // ⌘W / Ctrl+W:关闭当前页签(与侧边栏里 ⌘W 关当前页签同义)。
  useCloseShortcutShellOwner();
  useAppShortcut('close-tab-or-window', () => {
    if (activeTabId) {
      void closeHostedTab(activeTabId).catch((err) => {
        log.warn('close active popped-out tab failed', { tabId: activeTabId, err });
      });
    }
    return true;
  });

  // 「+」新建的页签:乐观登记为本窗口承载,并请 main 收编(主窗据广播不画它)。
  const handleTabCreated = useCallback(
    (tabId: string) => {
      addHostedTabId(tabId);
      const created = isGlobalTabId(tabId) ? null : sessionId;
      void api?.adoptTab?.({ tabId, sessionId: created }).catch((err) => {
        log.warn('adopt new tab failed', { tabId, err });
      });
    },
    [api, sessionId],
  );

  const context = assignment?.context;
  const topbarLeading = <div className={isMac ? 'w-[72px] shrink-0' : 'w-1 shrink-0'} />;
  const topbarTrailing = (
    <>
      {activeTabId && (
        <div
          className="flex h-full shrink-0 items-center gap-0.5"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ChromeIconButton
            onClick={() => mergeBackTab(activeTabId)}
            aria-label={t('rightSidebar.tabWindow.mergeBack')}
          >
            <PanelRight size={14} />
          </ChromeIconButton>
        </div>
      )}
      {!isMac && (
        <div
          className="flex h-full shrink-0 items-center"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <WindowControls key={windowChromeRevision} onClose={closeAllHostedTabs} />
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-screen flex-col bg-content-area text-foreground">
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
            unifiedTopbar
            hostedTabIds={hostedTabIds}
            onMergeBackTab={mergeBackTab}
            onTabCreated={handleTabCreated}
            onActiveTabChange={setActiveTabId}
            topbarLeading={topbarLeading}
            topbarTrailing={topbarTrailing}
          />
        )}
        {(!windowVisible || !assignment || presentTabs.length === 0) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--panel-bg)]">
            <span className="text-13 text-[var(--text-tertiary)]">
              {assignment && contentReady && presentTabs.length === 0
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
