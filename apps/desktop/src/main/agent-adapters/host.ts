import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import {
  isScopedPeer,
  parseRemoteActionInvokeRequest,
  parseRemoteResourceGetRequest,
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
} from '@cindy/device-link';
import { AGENT_ADAPTER_COLLECTION, AGENT_ADAPTER_KIND } from '@cindy/maker-shared/agent-adapters';
import { AGENT_ADAPTER_IPC } from '../../shared/agentAdapters.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { readDeviceLinkSettings } from '../device-link/settings-store.js';
import {
  remoteResourceRegistry,
  RemoteResourceRegistryError,
} from '../device-link/remoteResourceRegistry.js';
import { listRecentWorkdirs } from '../localDb/ipc/recentWorkdirs.js';
import { validateExistingLocalProjectDirectory } from '../mcp-integrations/createProject.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { onQuit } from '../lifecycle.js';
import { agentAdapterSettings, agentAdaptersEnabled } from './settings.js';
import {
  createAdapterSessionService,
  AdapterSessionError,
  type AdapterSessionService,
  type AdapterWorkspace,
} from './sessions.js';
import { createAgentResourceProvider } from './resources.js';
import type { AgentAdapterRuntime } from './runtime.js';

/** Registered once after the owner-aware Maker host exists. No process starts on registration. */
export function registerAgentAdapterHost(getRuntime: () => AgentAdapterRuntime): void {
  let active: {
    runtime: AgentAdapterRuntime;
    service: AdapterSessionService;
    grants: Map<string, AdapterWorkspace>;
  } | null = null;
  let reaper: ReturnType<typeof setInterval> | undefined;
  let cleanup = Promise.resolve();
  const allowed = (controller: string) => {
    if (controller === 'local') return true;
    const settings = readDeviceLinkSettings();
    return (
      !isScopedPeer(controller) &&
      settings.remoteControlEnabled &&
      !settings.revokedControllers.includes(controller)
    );
  };
  const guard = (controller: string) => {
    const owner = activeOwnerScopeKey(),
      context = getDeviceLinkInvokeContext();
    const trusted =
      controller === 'local'
        ? !context
        : context?.controllerDeviceId === controller &&
          !context.sharedTask &&
          [
            REMOTE_RESOURCE_GET_CHANNEL,
            REMOTE_RESOURCE_INVOKE_CHANNEL,
            REMOTE_RESOURCE_LIST_CHANNEL,
          ].includes(context.channel);
    return () => {
      if (
        !trusted ||
        isAppSessionBoundaryPending() ||
        owner !== activeOwnerScopeKey() ||
        !allowed(controller)
      )
        throw new RemoteResourceRegistryError('NOT_FOUND', 'External Agent unavailable');
    };
  };
  const dispose = (): Promise<void> => {
    clearInterval(reaper);
    reaper = undefined;
    const previous = active;
    active = null;
    if (previous) {
      previous.runtime.dispose();
      const pending = previous.service.dispose().finally(() => previous.grants.clear());
      cleanup = Promise.allSettled([cleanup, pending]).then(() => {});
    }
    return cleanup;
  };
  const validate = async (root: string) => {
    const result = await validateExistingLocalProjectDirectory(root);
    if (!result.ok) throw new AdapterSessionError('unavailable');
    return result.workingDir;
  };
  const ensure = () => {
    const runtime = getRuntime();
    if (!runtime.enabled || runtime.signal.aborted || isAppSessionBoundaryPending())
      throw new AdapterSessionError('disabled');
    if (active?.runtime === runtime) return active;
    // dispose marks its service stale synchronously, before cleanup awaits.
    void dispose();
    const owner = activeOwnerScopeKey();
    const grants = new Map<string, AdapterWorkspace>();
    const service = createAdapterSessionService({
      runtime,
      isCurrent: () => owner === activeOwnerScopeKey() && !isAppSessionBoundaryPending(),
      isControllerAllowed: allowed,
      validateWorkspace: validate,
      listWorkspaces: async () => {
        const recent = await listRecentWorkdirs();
        if (owner !== activeOwnerScopeKey() || runtime.signal.aborted)
          throw new AdapterSessionError('stale');
        for (const item of recent.filter((item) => item.exists).slice(0, 200)) {
          if (!grants.has(item.path))
            grants.set(item.path, {
              id: randomUUID(),
              label: path.basename(item.path),
              root: item.path,
            });
        }
        // No host filesystem paths cross the resource boundary.
        return [...grants.values()].slice(0, 200);
      },
    });
    active = { runtime, service, grants };
    runtime.signal.addEventListener(
      'abort',
      () => {
        if (active?.runtime === runtime) void dispose();
      },
      { once: true },
    );
    reaper = setInterval(() => {
      if (!agentAdaptersEnabled()) {
        void dispose();
        return;
      }
      service.reap(allowed);
    }, 10_000);
    reaper.unref();
    return active;
  };
  const provider = createAgentResourceProvider({
    enabled: agentAdaptersEnabled,
    service: () => ensure().service,
    guard,
  });
  const unregister = remoteResourceRegistry.register(provider);
  const local = { controllerDeviceId: 'local' };
  const safely = async <T>(operation: () => Promise<T>) => {
    try {
      return await operation();
    } catch (error) {
      throwIpcError(
        error instanceof RemoteResourceRegistryError && error.code === 'INVALID_PARAMS'
          ? 'INVALID_PARAMS'
          : 'PRECONDITION_FAILED',
        'External Agent unavailable',
      );
    }
  };
  ipcMain.handle(AGENT_ADAPTER_IPC.get, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseRemoteResourceGetRequest(raw);
    if (
      !request ||
      request.ref.collectionId !== AGENT_ADAPTER_COLLECTION ||
      request.ref.kind !== AGENT_ADAPTER_KIND
    )
      throwIpcError('INVALID_PARAMS', 'Invalid Agent resource');
    return safely(() => provider.get!(local, request));
  });
  ipcMain.handle(AGENT_ADAPTER_IPC.invoke, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseRemoteActionInvokeRequest(raw);
    if (
      !request ||
      request.collectionId !== AGENT_ADAPTER_COLLECTION ||
      request.resourceRef?.collectionId !== AGENT_ADAPTER_COLLECTION ||
      request.resourceRef.kind !== AGENT_ADAPTER_KIND
    )
      throwIpcError('INVALID_PARAMS', 'Invalid Agent action');
    return safely(() => provider.invoke!(local, request));
  });
  ipcMain.handle(AGENT_ADAPTER_IPC.settings, (event) => {
    assertTrustedAppRendererEvent(event);
    return safely(async () => {
      guard('local')();
      const enabled = agentAdaptersEnabled();
      return { enabled, customized: agentAdapterSettings.readState().isCustomized };
    });
  });
  ipcMain.handle(AGENT_ADAPTER_IPC.configure, (event, enabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof enabled !== 'boolean' && enabled !== null)
      throwIpcError('INVALID_PARAMS', 'Invalid Agent setting');
    const check = guard('local');
    return safely(async () => {
      check();
      if (enabled === null) await agentAdapterSettings.resetAtomic();
      else await agentAdapterSettings.writePatchAtomic({ enabled }, { preserveDefaults: true });
      check();
      await dispose();
      check();
      getRuntime();
    });
  });
  ipcMain.handle(AGENT_ADAPTER_IPC.pickDirectory, (event) => {
    assertTrustedAppRendererEvent(event);
    const check = guard('local');
    return safely(async () => {
      check();
      const target = ensure();
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      check();
      if (result.canceled || !result.filePaths[0]) return false;
      const root = await validate(result.filePaths[0]);
      check();
      if (target !== active || target.runtime.signal.aborted)
        throw new AdapterSessionError('stale');
      if (target.grants.size >= 200 && !target.grants.has(root))
        throw new AdapterSessionError('limit');
      target.grants.set(root, { id: randomUUID(), label: path.basename(root), root });
      return true;
    });
  });
  onQuit(
    'agent-adapters',
    async () => {
      unregister();
      await dispose();
    },
    'async',
  );
}
