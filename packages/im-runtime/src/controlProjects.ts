export interface ControlProject {
  /** 归一化后的 workingDir (POSIX 斜杠, 无 trailing slash)。 */
  workingDir: string;
  /** 显示名: basename, 必要时 `parent/basename` 消歧。 */
  displayName: string;
  /** 组内最大 sortTime (userSendAt ?? updatedAt), 用于组间排序; unix ms。 */
  latestActivityMs: number;
}

export interface ControlSession {
  id: string;
  title: string;
  /** sortTime = userSendAt ?? updatedAt, unix ms。 */
  sortTimeMs: number;
}

/**
 * 列出某 workingDir 下所有 desktop active sessions, 按 sortTime desc。
 *
 * 关键点: 入参 workingDir 是归一化后的 POSIX 路径, 但 DB 里的 working_dir 列存的
 * 是原始路径 (可能是 Windows 反斜杠 + 末尾斜杠)。直接 `eq` 会漏命中, 所以这里
 * 拉取该 source/status 全集后在内存里 normalize 比对 — 数据量受 MAX_PROJECTS
 * 推论上限制约 (一台机器的 active session 总数, 不会大), 不需要走 SQL 索引。
 */
export interface RecentControlSession extends ControlSession {
  /** 会话所在目录显示名(basename;托管 IM 目录显示为空串, 由 UI 兜底)。 */
  workspaceDisplayName: string;
}
