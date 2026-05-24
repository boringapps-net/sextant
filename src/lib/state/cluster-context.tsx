import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { K8sClient, type ClusterConnection } from '../k8s/client';
import { DemoK8sClient, isDemoCluster } from '../k8s/demo/client';
import {
  listClusters,
  saveCluster,
  deleteCluster as removeCluster,
  getActiveClusterId,
  setActiveClusterId,
  getActiveNamespace,
  setActiveNamespace,
} from '../storage/clusters';

type ClusterContextValue = {
  loading: boolean;
  clusters: ClusterConnection[];
  active: ClusterConnection | null;
  activeNamespace: string | undefined;
  client: K8sClient | null;
  reload: () => Promise<void>;
  saveAndActivate: (c: ClusterConnection) => Promise<void>;
  remove: (id: string) => Promise<void>;
  activate: (id: string) => Promise<void>;
  setNamespace: (ns: string | undefined) => Promise<void>;
};

const ClusterContext = createContext<ClusterContextValue | null>(null);

export function ClusterProvider({ children }: { children: React.ReactNode }) {
  const [clusters, setClusters] = useState<ClusterConnection[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [activeNamespace, setActiveNamespaceState] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [cs, id, ns] = await Promise.all([
      listClusters(),
      getActiveClusterId(),
      getActiveNamespace(),
    ]);
    setClusters(cs);
    setActiveId(id ?? cs[0]?.id);
    setActiveNamespaceState(ns);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const active = useMemo(
    () => clusters.find((c) => c.id === activeId) ?? null,
    [clusters, activeId],
  );
  const client = useMemo(() => {
    if (!active) return null;
    // The demo cluster is a sentinel ClusterConnection — route it to the
    // in-memory DemoK8sClient instead of the network-backed K8sClient.
    return isDemoCluster(active) ? new DemoK8sClient() : new K8sClient(active);
  }, [active]);

  const saveAndActivate = useCallback(async (c: ClusterConnection) => {
    await saveCluster(c);
    await setActiveClusterId(c.id);
    await reload();
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    await removeCluster(id);
    await reload();
  }, [reload]);

  const activate = useCallback(async (id: string) => {
    await setActiveClusterId(id);
    setActiveId(id);
  }, []);

  const setNamespace = useCallback(async (ns: string | undefined) => {
    await setActiveNamespace(ns);
    setActiveNamespaceState(ns);
  }, []);

  const value: ClusterContextValue = {
    loading,
    clusters,
    active,
    activeNamespace,
    client,
    reload,
    saveAndActivate,
    remove,
    activate,
    setNamespace,
  };

  return <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>;
}

export function useClusters() {
  const v = useContext(ClusterContext);
  if (!v) throw new Error('useClusters used outside ClusterProvider');
  return v;
}
