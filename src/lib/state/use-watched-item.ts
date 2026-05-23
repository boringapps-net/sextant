import { useEffect, useState } from 'react';
import type { ResourceDef } from '../k8s/resources';
import type { K8sObject } from '../k8s/types';
import type { StreamHandle } from 'expo-k8s-mtls';
import { useClusters } from './cluster-context';

// Watch a single resource. We use a list-watch with fieldSelector=name=X
// instead of a name-scoped GET subscription because the K8s API only supports
// watches on collections. The single-row stream is just as cheap.
export function useWatchedItem<T extends K8sObject = K8sObject>(
  def: ResourceDef | undefined,
  name: string | undefined,
  namespace: string | undefined,
): {
  item: T | null;
  loading: boolean;
  error: string | null;
} {
  const { client } = useClusters();
  const [item, setItem] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !def || !name) {
      setItem(null);
      setLoading(false);
      return;
    }

    let mounted = true;
    let stream: StreamHandle | null = null;
    let consecutiveErrors = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    setLoading(true);
    setError(null);

    async function getAndWatch() {
      if (!mounted || !client || !def) return;
      try {
        const got = await client.get<T>(def, name!, namespace);
        if (!mounted) return;
        setItem(got);
        setLoading(false);
        consecutiveErrors = 0;
        let rv = got.metadata.resourceVersion ?? '';

        stream = client.watch<T>(
          def,
          {
            namespace,
            fieldSelector: `metadata.name=${name}`,
            resourceVersion: rv,
            allowBookmarks: true,
          },
          {
            onEvent: (e) => {
              if (!mounted) return;
              if (e.type === 'BOOKMARK') {
                rv = e.object.metadata?.resourceVersion ?? rv;
                return;
              }
              if (e.type === 'ERROR') return;
              const obj = e.object;
              if (!obj?.metadata || obj.metadata.name !== name) return;
              if (obj.metadata.resourceVersion) rv = obj.metadata.resourceVersion;
              if (e.type === 'DELETED') {
                setItem(null);
                setError('Resource deleted');
              } else {
                setItem(obj);
              }
            },
            onError: (err) => {
              if (!mounted) return;
              consecutiveErrors++;
              setError(err.message);
              scheduleReconnect();
            },
            onDone: () => {
              if (!mounted) return;
              scheduleReconnect();
            },
          },
        );
      } catch (e: any) {
        if (!mounted) return;
        consecutiveErrors++;
        setError(e?.message ?? String(e));
        setLoading(false);
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (!mounted) return;
      if (reconnectTimer) return;
      const delay = consecutiveErrors === 0
        ? 200
        : Math.min(30_000, 1000 * Math.pow(2, consecutiveErrors - 1));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        stream?.stop();
        stream = null;
        getAndWatch();
      }, delay);
    }

    getAndWatch();
    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stream?.stop();
    };
  }, [client, def?.slug, name, namespace]);

  return { item, loading, error };
}
