import type { ProviderView } from './registry.js';

/** Remote Agent selection only. A remote-control view of the computer itself retains its full catalog. */
export function remoteInvocationModels(provider: ProviderView): ProviderView {
  if (provider.remoteModelIds === undefined) return provider;
  const ids = provider.remoteModelIds;
  const allowed = new Set(Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? ids : []);
  return { ...provider, models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([agent, models]) => [
    agent, models?.filter((model) => allowed.has(model.id)),
  ])) };
}
