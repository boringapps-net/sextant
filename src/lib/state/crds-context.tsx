import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useClusters } from './cluster-context';
import type { ResourceDef } from '../k8s/resources';
import { BUILTIN_RESOURCES, crdSlug } from '../k8s/resources';

// Discovered (CRD) resources for the active cluster.
type CRDContextValue = {
  loading: boolean;
  error: string | null;
  crds: ResourceDef[];
  refresh: () => Promise<void>;
};

const Ctx = createContext<CRDContextValue | null>(null);

// Built-in groups we don't want duplicated in the "Custom" drawer section.
const BUILTIN_GROUPS = new Set(BUILTIN_RESOURCES.map((r) => `${r.apiGroup}|${r.plural}`));

export function CRDProvider({ children }: { children: React.ReactNode }) {
  const { client, active } = useClusters();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crds, setCrds] = useState<ResourceDef[]>([]);

  const refresh = useCallback(async () => {
    if (!client) {
      setCrds([]);
      return;
    }
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    try {
      const groups = await client.apiGroups(ctrl.signal);
      const results: ResourceDef[] = [];
      // Limit parallelism to keep mobile networks happy.
      const queue = groups.groups.map((g) => g.preferredVersion.groupVersion);
      const concurrency = 4;
      let i = 0;
      async function worker() {
        while (i < queue.length) {
          const gv = queue[i++];
          try {
            const rl = await client!.groupResources(gv, ctrl.signal);
            const [group, version] = gv.includes('/') ? gv.split('/') : ['', gv];
            for (const r of rl.resources) {
              // Skip subresources (names contain "/") and built-ins
              if (r.name.includes('/')) continue;
              if (BUILTIN_GROUPS.has(`${group}|${r.name}`)) continue;
              if (!r.verbs?.includes('list')) continue;
              results.push({
                slug: crdSlug(r.name, group),
                kind: r.kind,
                apiGroup: group,
                apiVersion: version,
                plural: r.name,
                namespaced: r.namespaced,
                category: 'Custom',
                icon: { ios: 'cube.transparent', android: 'extension' },
              });
            }
          } catch {
            // Swallow per-group discovery errors; one bad group shouldn't kill the list.
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      results.sort((a, b) =>
        a.apiGroup.localeCompare(b.apiGroup) || a.kind.localeCompare(b.kind),
      );
      setCrds(results);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, active?.id]);

  return <Ctx.Provider value={{ loading, error, crds, refresh }}>{children}</Ctx.Provider>;
}

export function useCRDs() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCRDs used outside CRDProvider');
  return v;
}
