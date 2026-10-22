import type {
  RemoteActionInvokeRequest,
  RemoteActionInvokeResponse,
  RemoteResource,
  RemoteResourceGetRequest,
} from '@cindy/device-link';
export const AGENT_ADAPTER_IPC = {
  get: 'agent-adapters:get',
  invoke: 'agent-adapters:invoke',
  settings: 'agent-adapters:settings',
  configure: 'agent-adapters:configure',
  pickDirectory: 'agent-adapters:pick-directory',
} as const;
export interface AgentAdaptersBridge {
  get(request: RemoteResourceGetRequest): Promise<RemoteResource>;
  invoke(request: RemoteActionInvokeRequest): Promise<RemoteActionInvokeResponse>;
  settings(): Promise<{ enabled: boolean; customized: boolean }>;
  configure(enabled: boolean | null): Promise<void>;
  pickDirectory(): Promise<boolean>;
}
