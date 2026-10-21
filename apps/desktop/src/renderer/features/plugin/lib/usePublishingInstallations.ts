import { useEffect, useState } from 'react';
import type { InstalledGhost } from '../../../../shared/ghost';
import type { MyPluginView } from '../../../../shared/pluginContributions';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

/** Rebuildable exact install/ACL projection. Never derives ownership from package metadata. */
export function usePublishingInstallations(owner: string, personal: boolean, ghosts: InstalledGhost[]) {
  const installationKey = JSON.stringify(ghosts.map(ghost => [installedGhostStoragePart(ghost), ghost.dir,
    ghost.approval, ghost.publishingSource]));
  const key = JSON.stringify([owner, personal, installationKey]);
  const [result, setResult] = useState<{ key: string; plugins: MyPluginView[] } | null>(null);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      setResult(null);
      if (!personal || !navigator.onLine || !ghosts.some(ghost => ghost.publishingSource?.kind === 'public-market')) return;
      try {
        const plugins: MyPluginView[] = [];
        let cursor: string | undefined;
        do {
          const page = await window.electronAPI.pluginContributions.list({ query: '', filter: 'all', cursor });
          if (disposed || request !== generation) return;
          plugins.push(...page.plugins);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        setResult({ key, plugins });
      } catch {
        // Unknown current permission cannot preserve an old write candidate.
      }
    };
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    const offline = () => { generation++; setResult(null); };
    void refresh();
    window.addEventListener('focus', foreground);
    window.addEventListener('online', foreground);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      disposed = true;
      window.removeEventListener('focus', foreground);
      window.removeEventListener('online', foreground);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', foreground);
    };
  // The serialized key binds every source, approval, directory and owner generation.
  }, [key]);
  return result?.key === key ? result.plugins : [];
}
