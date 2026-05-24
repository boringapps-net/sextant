import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Linking } from 'react-native';
import { useClusters } from './cluster-context';
import type { PortForwardHandle } from 'expo-k8s-mtls';

// One active port forward, viewed from the JS side. Mirrors what the native
// session emits via its event callbacks, plus the bookkeeping we need to
// drive the UI (kind/name/namespace are derived from the start args, not
// fetched).
export type PortForwardEntry = {
  id: string;
  // What the user asked us to forward TO. Note that for Service forwards we
  // do the Endpoints lookup at the call site and start a Pod forward — the
  // entry remembers the original Service so the UI can label it nicely.
  sourceKind: 'Pod' | 'Service';
  sourceName: string;
  podName: string;
  namespace: string;
  remotePort: number;
  /** Bound 127.0.0.1 port. 0 while the listener is still binding. */
  localPort: number;
  status: 'starting' | 'listening' | 'closing' | 'closed' | 'error';
  /** Most recent error message, if any. Cleared on a fresh successful event. */
  error?: string;
  /** Number of currently-active TCP bridges (a single browser request may open one). */
  bridges: number;
  /** Cluster id this forward belongs to. Forwards are scoped to a cluster. */
  clusterId: string;
  startedAt: number;
};

export type StartPortForwardArgs = {
  sourceKind: 'Pod' | 'Service';
  sourceName: string;
  podName: string;
  namespace: string;
  remotePort: number;
  localPort?: number;
};

type PortForwardContextValue = {
  forwards: PortForwardEntry[];
  /**
   * Start a forward. Resolves once the listener is up (so callers know which
   * port the browser should hit). Rejects on early failure.
   */
  start(args: StartPortForwardArgs): Promise<PortForwardEntry>;
  stop(id: string): void;
  stopAll(): void;
};

const PortForwardContext = createContext<PortForwardContextValue | null>(null);

export function PortForwardProvider({ children }: { children: React.ReactNode }) {
  const { client, active } = useClusters();
  const [forwards, setForwards] = useState<PortForwardEntry[]>([]);
  // Native handles aren't serialisable so they live outside React state. We
  // key by id so `stop(id)` can find the right handle.
  const handles = useRef<Map<string, PortForwardHandle>>(new Map());

  const upsert = useCallback((id: string, patch: Partial<PortForwardEntry>) => {
    setForwards((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const remove = useCallback((id: string) => {
    handles.current.delete(id);
    setForwards((rs) => rs.filter((r) => r.id !== id));
  }, []);

  const start = useCallback(
    (args: StartPortForwardArgs): Promise<PortForwardEntry> => {
      if (!client || !active) {
        return Promise.reject(new Error('No active cluster'));
      }
      return new Promise<PortForwardEntry>((resolve, reject) => {
        let entry: PortForwardEntry = {
          // Filled in once we have the native id back. React state insertion
          // happens after we know the id.
          id: '',
          sourceKind: args.sourceKind,
          sourceName: args.sourceName,
          podName: args.podName,
          namespace: args.namespace,
          remotePort: args.remotePort,
          localPort: args.localPort ?? 0,
          status: 'starting',
          bridges: 0,
          clusterId: active.id,
          startedAt: Date.now(),
        };
        let settled = false;

        // K8sClient.portForward signature is (namespace, podName, remotePort, …).
        // Heavy console logging while we debug port-forward end-to-end —
        // the bridge dies silently in too many places to track without
        // tracing every native callback in Metro.
        const label = `[pf] ${args.sourceKind.toLowerCase()}/${args.sourceName}:${args.remotePort}`;
        console.log(`${label} starting (pod ${args.namespace}/${args.podName})`);
        const handle = client.portForward(
          args.namespace,
          args.podName,
          args.remotePort,
          {
            onListening: ({ localPort }) => {
              console.log(`${label} listening on 127.0.0.1:${localPort}`);
              entry = { ...entry, localPort, status: 'listening' };
              upsert(entry.id, entry);
              if (!settled) {
                settled = true;
                resolve(entry);
              }
            },
            onStatus: ({ kind, bridges }) => {
              console.log(`${label} status: ${kind} (bridges=${bridges})`);
              upsert(entry.id, { bridges });
            },
            onError: ({ name, message }) => {
              const errStr = name ? `${name}: ${message}` : message;
              console.warn(`${label} ERROR: ${errStr}`);
              upsert(entry.id, { status: 'error', error: errStr });
              if (!settled) {
                settled = true;
                reject(new Error(errStr));
              }
            },
            onClosed: ({ reason }) => {
              console.log(`${label} closed (${reason})`);
              upsert(entry.id, { status: 'closed' });
              // Drop the entry shortly after so the UI shows the close briefly.
              setTimeout(() => remove(entry.id), 400);
              if (!settled) {
                settled = true;
                reject(new Error('Forward closed before listener was up'));
              }
            },
          },
          { localPort: args.localPort },
        );

        entry = { ...entry, id: handle.id };
        handles.current.set(handle.id, handle);
        setForwards((rs) => [...rs, entry]);
      });
    },
    [client, active, remove, upsert],
  );

  const stop = useCallback((id: string) => {
    const h = handles.current.get(id);
    if (!h) return;
    upsert(id, { status: 'closing' });
    h.stop();
  }, [upsert]);

  const stopAll = useCallback(() => {
    for (const id of Array.from(handles.current.keys())) {
      handles.current.get(id)?.stop();
    }
  }, []);

  // Tear down any active forwards when the cluster changes — the new cluster
  // doesn't know about them and the handles' creds were bound to the old one.
  useEffect(() => {
    return () => {
      stopAll();
    };
  }, [active?.id, stopAll]);

  const value = useMemo<PortForwardContextValue>(
    () => ({ forwards, start, stop, stopAll }),
    [forwards, start, stop, stopAll],
  );

  return <PortForwardContext.Provider value={value}>{children}</PortForwardContext.Provider>;
}

export function usePortForwards() {
  const v = useContext(PortForwardContext);
  if (!v) throw new Error('usePortForwards used outside PortForwardProvider');
  return v;
}

/**
 * Convenience wrapper that starts a forward and, on success, prompts the user
 * to open http://127.0.0.1:<localPort> in their default browser. On failure
 * shows an Alert with the underlying error so the user isn't left guessing.
 */
export function useStartPortForward() {
  const { start } = usePortForwards();
  return useCallback(
    async (args: StartPortForwardArgs): Promise<PortForwardEntry | undefined> => {
      try {
        const entry = await start(args);
        const url = `http://127.0.0.1:${entry.localPort}`;
        const sourceLabel =
          args.sourceKind === 'Service'
            ? `svc/${args.sourceName}  →  ${args.podName}:${args.remotePort}`
            : `${args.podName}:${args.remotePort}`;
        Alert.alert(
          'Port forward ready',
          `Listening on ${url}\nForwarding to ${sourceLabel}`,
          [
            { text: 'Done', style: 'cancel' },
            {
              text: 'Open in Safari',
              onPress: () => {
                void Linking.openURL(url).catch((e) => {
                  Alert.alert('Could not open browser', e?.message ?? String(e));
                });
              },
            },
          ],
        );
        return entry;
      } catch (e: any) {
        Alert.alert('Could not start port forward', e?.message ?? String(e));
        return undefined;
      }
    },
    [start],
  );
}
