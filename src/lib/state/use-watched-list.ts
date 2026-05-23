import { useEffect, useMemo, useState } from 'react';
import type { ResourceDef } from '../k8s/resources';
import type { K8sObject } from '../k8s/types';
import type { StreamHandle } from 'expo-k8s-mtls';
import { objectKey } from '../k8s/watch';
import { useClusters } from './cluster-context';

export type UseWatchedListOptions = {
  // Override the active namespace (use undefined to mean "all" when namespaced).
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  // Sort comparator over the K8sObjects in the list. Default: by metadata.name.
  // Provide your own if you need creation-time ordering or kind-specific sorts.
  compare?: (a: K8sObject, b: K8sObject) => number;
};

type State<T> = {
  byKey: Map<string, T>;
  loading: boolean;
  error: string | null;
};

// LIST-then-WATCH: holds items in a Map keyed by UID so MODIFIED events only
// change one entry's identity, leaving every other row's reference === stable.
// FlatList then short-circuits re-render on rows whose `item` prop is the same.
//
// The hook re-lists+re-watches whenever the cluster, kind, or selectors change,
// and reconnects on watch close/error. Cleanup tears down the stream.
export function useWatchedList<T extends K8sObject = K8sObject>(
  def: ResourceDef | undefined,
  options: UseWatchedListOptions = {},
): {
  items: T[];
  loading: boolean;
  error: string | null;
} {
  const { client, activeNamespace } = useClusters();
  const ns = def?.namespaced ? options.namespace ?? activeNamespace : undefined;

  const [state, setState] = useState<State<T>>({
    byKey: new Map(),
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!client || !def) {
      setState({ byKey: new Map(), loading: false, error: null });
      return;
    }

    let mounted = true;
    let stream: StreamHandle | null = null;
    // We backoff after consecutive failures so a broken cluster doesn't
    // hammer the API server in a tight loop.
    let consecutiveErrors = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    async function listAndWatch() {
      if (!mounted || !client || !def) return;
      try {
        const listed = await client.list<T>(def, {
          namespace: ns,
          labelSelector: options.labelSelector,
          fieldSelector: options.fieldSelector,
        });
        if (!mounted) return;

        const next = new Map<string, T>();
        for (const item of listed.items) next.set(objectKey(item), item);
        // resourceVersion to seed the watch from. The server treats this as
        // "start sending events newer than X".
        let rv = listed.metadata.resourceVersion ?? '';
        setState({ byKey: next, loading: false, error: null });
        consecutiveErrors = 0;

        stream = client.watch<T>(
          def,
          {
            namespace: ns,
            labelSelector: options.labelSelector,
            fieldSelector: options.fieldSelector,
            resourceVersion: rv,
            allowBookmarks: true,
          },
          {
            onEvent: (e) => {
              if (!mounted) return;
              // BOOKMARK: lightweight RV-update so we can resume from a
              // recent point. Not strictly used here because we relist on
              // every disconnect, but cheap to track.
              if (e.type === 'BOOKMARK') {
                rv = e.object.metadata?.resourceVersion ?? rv;
                return;
              }
              if (e.type === 'ERROR') {
                // The server sends ERROR + closes the stream, typically on
                // "too old resource version". Force a fresh relist when the
                // stream closes; nothing to do here.
                return;
              }
              const item = e.object;
              if (!item?.metadata) return;
              if (item.metadata.resourceVersion) rv = item.metadata.resourceVersion;

              setState((prev) => {
                const map = new Map(prev.byKey);
                const key = objectKey(item);
                if (e.type === 'DELETED') {
                  if (!map.has(key)) return prev;
                  map.delete(key);
                } else {
                  map.set(key, item);
                }
                return { ...prev, byKey: map };
              });
            },
            onError: (err) => {
              if (!mounted) return;
              consecutiveErrors++;
              setState((prev) => ({ ...prev, error: err.message }));
              scheduleReconnect();
            },
            onDone: () => {
              if (!mounted) return;
              // Clean close (5-min timeout or peer hangup) — reconnect quickly.
              scheduleReconnect();
            },
          },
        );
      } catch (e: any) {
        if (!mounted) return;
        consecutiveErrors++;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: e?.message ?? String(e),
        }));
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (!mounted) return;
      if (reconnectTimer) return;
      // Quick reconnect after clean close, exponential backoff after errors.
      const delay = consecutiveErrors === 0
        ? 200
        : Math.min(30_000, 1000 * Math.pow(2, consecutiveErrors - 1));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        stream?.stop();
        stream = null;
        listAndWatch();
      }, delay);
    }

    listAndWatch();

    return () => {
      mounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stream?.stop();
    };
    // We want a fresh list+watch when the cluster, kind, or selectors change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, def?.slug, ns, options.labelSelector, options.fieldSelector]);

  const items = useMemo(() => {
    const arr = Array.from(state.byKey.values());
    const cmp = options.compare ??
      ((a: K8sObject, b: K8sObject) => a.metadata.name.localeCompare(b.metadata.name));
    arr.sort(cmp);
    return arr;
  }, [state.byKey, options.compare]);

  return { items, loading: state.loading, error: state.error };
}
