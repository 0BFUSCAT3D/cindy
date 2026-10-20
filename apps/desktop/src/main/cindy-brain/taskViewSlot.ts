/**
 * taskViewSlot.ts — 任务页开页槽(taskView)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'task-view-request', sessionId?}`,请主机在指定任务的
 * 右侧栏打开(或聚焦)它自己的任务页页签。页签只承载插件自己的包内页面,
 * 不接收任何网址:没有跳转面,也就没有 preview 那样的白名单与限速。
 *
 * - 资格审:已装、启用、声明了 taskView;
 * - 落点:显式 sessionId 优先(通常来自 session-context 注入),缺省台前任务,
 *   两者皆无如实拒;sessionId 只做形状校验(右侧栏是本机用户自己的 UI);
 * - 成功回执带回实际落点任务,插件据此绑定自己的业务状态。
 *
 * 纯逻辑 + 依赖注入:广播在 cindy-brain/index.ts 组装时注入。
 */

import type { GhostPipeTaskViewResult, InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';

/** 推给 renderer 的开页载荷(实例 id 由主机按已装清单填,不信自报)。 */
export interface GhostTaskViewOpenPush {
  instanceId: string;
  sessionId: string;
}

export interface TaskViewSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把开页请求推给宿主窗口;false = 一个窗口都不在(HOST_NOT_READY)。 */
  broadcast(payload: GhostTaskViewOpenPush): boolean;
  /** 台前任务快照(请求缺省 sessionId 时的落点;非任务页为 null)。 */
  focusedSessionId(): string | null;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

function fail(
  errorCode: Extract<GhostPipeTaskViewResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeTaskViewResult {
  return { ok: false, errorCode, message };
}

export class GhostTaskViewSlot {
  constructor(private readonly deps: TaskViewSlotDeps) {}

  handleRequest(ghostId: string, payload: unknown): GhostPipeTaskViewResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.taskView) {
      return fail('PERMISSION_DENIED', '插件未声明任务页(taskView),或当前未启用');
    }
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
      return fail('INVALID_REQUEST', 'task-view-request 载荷必须是对象');
    }
    const request = (payload ?? {}) as Record<string, unknown>;
    if (request.sessionId !== undefined) {
      if (typeof request.sessionId !== 'string' || !SESSION_ID_RE.test(request.sessionId)) {
        return fail('INVALID_REQUEST', 'sessionId 形状不合法');
      }
    }
    const sessionId =
      typeof request.sessionId === 'string' ? request.sessionId : this.deps.focusedSessionId();
    if (!sessionId) return fail('HOST_NOT_READY', '当前没有任务可承载任务页');
    const delivered = this.deps.broadcast({ instanceId: installedGhostStoragePart(ghost), sessionId });
    if (!delivered) return fail('HOST_NOT_READY', '当前没有可用的宿主窗口');
    this.deps.log?.info('ghost task view open requested', { ghostId, sessionId });
    return { ok: true, sessionId };
  }
}
