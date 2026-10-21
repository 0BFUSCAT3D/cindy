/**
 * 伙伴近况里的「待办」数据：本机伙伴读本机宿主，别的电脑上的伙伴经 device-link 读那台的远程资源
 * （与手机同一条 `todos:<botId>` 路径，宿主已裁掉模型指令与内部来源标识）。
 *
 * 近况只展示、不编辑：点一条交给对话，右键删除可撤销。完成、改期、不再提示都由伙伴在对话里按主人的话去改。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REMOTE_RESOURCE_CHANGED_CHANNEL,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  parseRemoteResourceChangedPayload,
  type RemoteResourceGetRequest,
} from '@cindy/device-link';
import {
  queryTodoItems,
  todoDue,
  type TeammateTodo,
  type TodoListQuery,
  type TodoPatch,
} from '@cindy/maker-shared/teammate-todo';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';

/** 近况一屏最多带回多少条；更多的交给「显示更多」在同一页里展开。 */
const PAGE = 25;

export interface GlanceTodoHost {
  botId: string;
  /** 伙伴所在的另一台电脑；本机伙伴为 undefined。 */
  deviceId?: string;
}

export interface GlanceTodos {
  open: TeammateTodo[];
  openTotal: number;
  done: TeammateTodo[];
  doneTotal: number;
}

const EMPTY: GlanceTodos = { open: [], openTotal: 0, done: [], doneTotal: 0 };

function todosRef(botId: string) {
  return { collectionId: 'teammates', kind: 'bot', id: `todos:${botId}` } as const;
}

async function readRemotePage(deviceId: string, botId: string, query: TodoListQuery) {
  const request: RemoteResourceGetRequest = {
    client: { protocolVersion: 1, primitives: ['teammate-todos'], locale: document.documentElement.lang || undefined },
    ref: todosRef(botId),
    query: JSON.stringify(query),
  };
  const resource = await window.electronAPI.deviceLink.invoke(deviceId, REMOTE_RESOURCE_GET_CHANNEL, [request]);
  const blocks = (resource as { blocks?: Array<{ primitive?: string; data?: unknown }> } | null)?.blocks;
  const page = blocks?.find((block) => block.primitive === 'teammate-todos')?.data as
    | { items?: TeammateTodo[]; total?: number; completedTotal?: number }
    | undefined;
  if (!page || !Array.isArray(page.items)) throw new Error('invalid todo page');
  return { items: page.items, total: page.total ?? page.items.length };
}

async function readTodos(host: GlanceTodoHost): Promise<GlanceTodos> {
  if (!host.deviceId) {
    const { items } = await window.electronAPI.localDb.bots.todos.list(host.botId);
    const open = queryTodoItems(items, { view: 'open', order: 'due', limit: PAGE });
    const done = queryTodoItems(items, { view: 'done', order: 'created', limit: PAGE });
    return {
      open: open.items,
      openTotal: open.total,
      done: [...done.items].reverse(),
      doneTotal: done.total,
    };
  }
  const [open, done] = await Promise.all([
    readRemotePage(host.deviceId, host.botId, { view: 'open', order: 'due', limit: PAGE }),
    readRemotePage(host.deviceId, host.botId, { view: 'done', order: 'created', limit: PAGE }),
  ]);
  return { open: open.items, openTotal: open.total, done: [...done.items].reverse(), doneTotal: done.total };
}

/** 本机或那台电脑上的一次待办更新；撤销删除走同一条路径的 `restore`。 */
export async function patchGlanceTodo(host: GlanceTodoHost, patch: TodoPatch): Promise<TeammateTodo | null> {
  if (!host.deviceId) return window.electronAPI.localDb.bots.todos.update(host.botId, patch);
  const result = await window.electronAPI.deviceLink.invoke(host.deviceId, REMOTE_RESOURCE_INVOKE_CHANNEL, [{
    client: { protocolVersion: 1, primitives: ['teammate-todos'] },
    collectionId: 'teammates',
    actionId: 'todo-update',
    resourceRef: todosRef(host.botId),
    input: patch as unknown as Record<string, unknown>,
  }]);
  return (result as { todo?: TeammateTodo | null } | null)?.todo ?? null;
}

/**
 * 读一位伙伴的待办。`enabled=false` 时不读也不订阅（例如名册里伙伴主任务还没就绪）。
 * 本机随宿主推送刷新；别的电脑上的随那台的远程资源变更推送刷新；回到前台时再读一次。
 */
export function useGlanceTodos(host: GlanceTodoHost, enabled = true) {
  const [state, setState] = useState<{ todos: GlanceTodos; loaded: boolean; failed: boolean }>({
    todos: EMPTY,
    loaded: false,
    failed: false,
  });
  const epoch = useRef(0);
  const { botId, deviceId } = host;

  const refresh = useCallback(async () => {
    if (!enabled || !botId) return;
    const mine = ++epoch.current;
    const owner = getDataOwnerGeneration();
    try {
      const todos = await readTodos({ botId, deviceId });
      if (mine !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
      setState({ todos, loaded: true, failed: false });
    } catch {
      if (mine !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
      setState((previous) => ({ ...previous, loaded: true, failed: true }));
    }
  }, [botId, deviceId, enabled]);

  useEffect(() => {
    setState({ todos: EMPTY, loaded: false, failed: false });
    if (!enabled || !botId) return;
    void refresh();
    const unsubscribe = deviceId
      ? window.electronAPI.deviceLink.onRemotePush((push, stamp) => {
          if (push.deviceId !== deviceId || push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL) return;
          if (!isDeviceLinkRemotePushCurrent(push, stamp)) return;
          const payload = parseRemoteResourceChangedPayload(push.payload);
          if (payload?.collectionId !== 'teammates') return;
          if (
            payload.resourceRefs?.length &&
            !payload.resourceRefs.some((ref) => ref.id === botId || ref.id === `todos:${botId}`)
          )
            return;
          void refresh();
        })
      : window.electronAPI.maker.onBotWorkbenchChanged((event) => {
          if (event.botId === botId) void refresh();
        });
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    return () => {
      epoch.current++;
      unsubscribe?.();
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
    };
  }, [botId, deviceId, enabled, refresh]);

  return { ...state, refresh };
}

/** 一条待办这一次到期的身份：改了期限就是一次新的到期，入口红点会再亮。 */
function dueKey(t: TeammateTodo): string {
  const deadline = t.deadlineOverride ? t.deadlineOverride.value : t.sourceDeadline;
  return `${t.id}@${deadline?.kind === 'instant' ? deadline.at : deadline?.date ?? ''}`;
}

const SEEN_PREFIX = 'cindy:bots:glance-due-seen:';

function readSeen(botId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_PREFIX + botId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

/** 到期的待办；入口红点只看主人还没在近况里看过的那几条。 */
export function dueTodos(todos: GlanceTodos, now = new Date()): TeammateTodo[] {
  return todos.open.filter((t) => todoDue(t, now));
}

export function hasUnseenDue(botId: string, due: readonly TeammateTodo[]): boolean {
  if (due.length === 0) return false;
  const seen = readSeen(botId);
  return due.some((t) => !seen.has(dueKey(t)));
}

/** 打开近况就算看过了：只记当前到期的这几条，旧记录随之淘汰。 */
export function markDueSeen(botId: string, due: readonly TeammateTodo[]): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + botId, JSON.stringify(due.map(dueKey)));
  } catch {
    // 本地存储不可用时只是红点多亮一次，不影响待办本身。
  }
}
