import { useSyncExternalStore } from 'react';
import { Navigate, useParams } from 'react-router-dom';

import { CCAgentSessionView } from './CCAgentSessionView';
import { provisionalDraftTaskId, subscribeProvisionalDraftTask } from './provisionalDraftTask';

/**
 * `/cc-agent/:sessionId`：新建页里还没发送的任务从任何入口打开(侧栏、搜索、深链)都回到
 * 新建页继续编辑——工作区、协同等草稿选项只在新建页上有。
 */
export function CCAgentSessionRoute() {
  const { sessionId } = useParams();
  const provisionalId = useSyncExternalStore(subscribeProvisionalDraftTask, provisionalDraftTaskId);
  if (sessionId && sessionId === provisionalId) return <Navigate to="/cc-agent/new" replace />;
  return <CCAgentSessionView />;
}
