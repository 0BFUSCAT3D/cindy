import path from 'node:path';
import {
  ConnectionPool, defaultSshConfigPath, defaultManagedSshConfigPath, readSshConfigDetailed,
  addManagedHostWithInclude, updateManagedHostFields, removeManagedHost,
  type HostConfig, type ReadSshConfigResult,
} from '@cindy/maker-remote-ssh';
import type { InvocationContext } from './contracts.js';
import type { RemoteResourceRegistry } from '@cindy/device-link';
import { privateDirectory } from './platform.js';

const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new Error('INVALID_SSH_ARGUMENT');
  return value.trim();
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SSH_ARGUMENT');
  return value as Record<string, unknown>;
};

/** One OpenSSH configuration graph and the existing host-key/authentication rules. */
export class TerminalSshService {
  readonly pool: ConnectionPool;
  private discovery?: ReadSshConfigResult;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private profileDir: string, emit: (channel: string, payload: unknown) => void) {
    this.pool = new ConnectionPool({ knownHostsPath: path.join(profileDir, 'ssh-known-hosts.json'), logger: { debug() {}, info() {}, warn() {}, error() {} } });
    this.pool.onAnyStatus(snapshot => emit('maker:remote-ssh:status-changed', snapshot));
  }
  async open() { await privateDirectory(this.profileDir); await this.reload(); }
  async reload() {
    if (this.closed) throw new Error('SERVICE_STOPPING');
    const result = await readSshConfigDetailed(defaultSshConfigPath(), { managedConfigPath: defaultManagedSshConfigPath() });
    if (result.diagnostic) throw new Error('SSH_CONFIGURATION_INVALID');
    if (this.closed) throw new Error('SERVICE_STOPPING');
    await this.pool.hydrate(result.hosts); this.discovery = result;
    return this.pool.list();
  }
  private parse(input: unknown, previous?: HostConfig): HostConfig {
    const data = object(input);
    const id = text(data.id ?? previous?.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)) throw new Error('INVALID_SSH_ALIAS');
    const port = data.port === undefined ? previous?.port ?? 22 : Number(data.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_SSH_PORT');
    const authMethod = data.authMethod ?? previous?.authMethod ?? 'agent';
    if (authMethod !== 'agent' && authMethod !== 'key') throw new Error('INVALID_SSH_AUTH_METHOD');
    const identityFile = data.identityFile === undefined ? previous?.identityFile : data.identityFile === '' ? undefined : text(data.identityFile);
    if (authMethod === 'key' && !identityFile) throw new Error('SSH_KEY_PATH_REQUIRED');
    return { id, hostname: text(data.hostname ?? previous?.hostname), user: text(data.user ?? previous?.user), port, authMethod, ...(identityFile ? { identityFile } : {}), source: 'ssh-config', managedByCindy: true };
  }
  async invoke(operation: string, args: unknown[], context: InvocationContext): Promise<unknown> {
    const guard = () => { if (this.closed) throw new Error('SERVICE_STOPPING'); context.assertCurrent?.(); };
    guard();
    if (operation === 'list' || operation === 'reload-config') return this.reload();
    if (operation === 'connect' || operation === 'disconnect') {
      const id = text(args[0]);
      if (!this.pool.get(id)) throw new Error('SSH_HOST_NOT_FOUND');
      await this.pool[operation](id); guard(); return this.pool.get(id)!.snapshot();
    }
    const mutation = this.pending.then(async () => {
      await this.reload(); guard();
      const managed = defaultManagedSshConfigPath();
      if (operation === 'add') {
        const host = this.parse(args[0]);
        await addManagedHostWithInclude(host, defaultSshConfigPath(), managed);
      } else if (operation === 'update' || operation === 'remove') {
        const id = text(args[0]);
        const previous = this.pool.get(id)?.config;
        if (!previous) throw new Error('SSH_HOST_NOT_FOUND');
        if (!previous.managedByCindy || !this.discovery?.managedConfigWriteToken) throw new Error('SSH_HOST_NOT_MANAGED');
        const token = this.discovery.managedConfigWriteToken;
        if (operation === 'remove') { await this.pool.disconnect(id); guard(); await removeManagedHost(id, managed, token); }
        else await updateManagedHostFields(this.parse({ ...object(args[1]), id }, previous), managed, token);
      } else throw new Error('UNKNOWN_SSH_OPERATION');
      guard(); return this.reload();
    });
    this.pending = mutation.catch(() => {});
    return mutation;
  }
  registerResources(registry: RemoteResourceRegistry) {
    const title = { fallback: 'SSH computers', translations: { 'zh-CN': 'SSH 电脑', 'zh-TW': 'SSH 電腦', ja: 'SSH コンピューター', ko: 'SSH 컴퓨터' } };
    const item = (id: string) => {
      const host = this.pool.get(id)?.snapshot();
      if (!host) throw new Error('SSH_HOST_NOT_FOUND');
      return { ref: { collectionId: 'ssh', kind: 'ssh-host', id }, revision: String(host.statusChangedAt), links: [], display: { title: host.config.displayName ?? id, subtitle: `${host.config.user}@${host.config.hostname}:${host.config.port}`, status: { label: host.status } }, actions: [{ id: host.status === 'ready' ? 'disconnect' : 'connect', label: host.status === 'ready' ? { fallback: 'Disconnect', translations: { 'zh-CN': '断开', 'zh-TW': '中斷', ja: '切断', ko: '연결 끊기' } } : { fallback: 'Connect', translations: { 'zh-CN': '连接', 'zh-TW': '連線', ja: '接続', ko: '연결' } } }] };
    };
    registry.register({
      collection: { id: 'ssh', resourceKind: 'ssh-host', title, placement: 'settings' },
      list: async () => { await this.reload(); return { collectionId: 'ssh', revision: '1', items: this.pool.list().map(host => item(host.config.id)) }; },
      get: async (_context, request) => item(request.ref.id),
      invoke: async (context, request) => {
        if (!request.resourceRef || !['connect', 'disconnect'].includes(request.actionId)) throw new Error('INVALID_SSH_ACTION');
        await this.invoke(request.actionId, [request.resourceRef.id], { source: 'local', assertCurrent: context.assertCurrent });
        return { effects: [{ kind: 'refresh-resource', ref: request.resourceRef }] };
      },
    });
  }
  async close() { this.closed = true; await this.pending; await this.pool.dispose(); }
}
