// In-memory mutable store backing the demo cluster. Holds K8sObjects keyed by
// kind / namespace / name, fires watch events on mutation, and runs a
// background tick that nudges things to make the cluster feel alive (metric
// fluctuations, the odd restart count bump, simulated rollouts).
//
// Singleton — the demo client creates one of these per app session.

import type { K8sObject } from '../types';
import type { WatchEvent } from '../watch';
import { buildInitialFixtures } from './fixtures';

type WatchHandler<T = K8sObject> = (event: WatchEvent<T>) => void;

type WatchSub = {
  id: number;
  kind: string;
  namespace?: string;
  // Used by useWatchedItem to filter by single-resource name; we only
  // implement the metadata.name=X case kubectl uses.
  fieldName?: string;
  handler: WatchHandler;
};

type LogSub = {
  id: number;
  namespace: string;
  podName: string;
  container?: string;
  handler: (line: string) => void;
};

let resourceVersionCounter = 100_000;
function nextResourceVersion(): string {
  resourceVersionCounter += 1;
  return String(resourceVersionCounter);
}

// Sinusoidal-with-noise generator scaled to a range. Each pod / node gets
// its own phase so they don't all oscillate in lockstep.
function oscillator(seed: string, range: [number, number], periodSec: number): (t: number) => number {
  // Cheap deterministic hash → [0, 2π)
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  const phase = (Math.abs(h) % 10_000) / 10_000 * 2 * Math.PI;
  const mid = (range[0] + range[1]) / 2;
  const amp = (range[1] - range[0]) / 2;
  return (t: number) => {
    const wave = Math.sin((t / (periodSec * 1000)) * 2 * Math.PI + phase);
    const noise = (Math.random() - 0.5) * 0.1 * (range[1] - range[0]);
    return mid + wave * amp + noise;
  };
}

class DemoStore {
  // kind → name-key → object
  private byKind: Map<string, Map<string, K8sObject>> = new Map();
  private watchers: WatchSub[] = [];
  private logSubs: LogSub[] = [];
  private nextWatcherId = 1;
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private logHandle: ReturnType<typeof setInterval> | null = null;
  // Per-pod/per-node metric generators created lazily on first request and
  // cached for the session so successive ticks produce continuous-looking
  // time series rather than independent random samples.
  private podCpu: Map<string, (t: number) => number> = new Map();
  private podMem: Map<string, (t: number) => number> = new Map();
  private nodeCpu: Map<string, (t: number) => number> = new Map();
  private nodeMem: Map<string, (t: number) => number> = new Map();

  constructor() {
    for (const obj of buildInitialFixtures()) {
      this.upsertQuiet(obj);
    }
    this.startTick();
    this.startLogTick();
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  list(kind: string, namespace?: string): K8sObject[] {
    const m = this.byKind.get(kind);
    if (!m) return [];
    if (!namespace) return Array.from(m.values());
    return Array.from(m.values()).filter((o) => o.metadata.namespace === namespace);
  }

  get(kind: string, namespace: string | undefined, name: string): K8sObject | null {
    const m = this.byKind.get(kind);
    if (!m) return null;
    return m.get(this.key(namespace, name)) ?? null;
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  upsert(obj: K8sObject): K8sObject {
    const existing = this.get(obj.kind, obj.metadata.namespace, obj.metadata.name);
    const next: K8sObject = {
      ...obj,
      metadata: { ...obj.metadata, resourceVersion: nextResourceVersion() },
    };
    this.upsertQuiet(next);
    this.fire(existing ? 'MODIFIED' : 'ADDED', next);
    return next;
  }

  delete(kind: string, namespace: string | undefined, name: string): K8sObject | null {
    const m = this.byKind.get(kind);
    if (!m) return null;
    const k = this.key(namespace, name);
    const obj = m.get(k);
    if (!obj) return null;
    m.delete(k);
    this.fire('DELETED', obj);
    return obj;
  }

  /** Apply a partial patch (deep-merge, with `null` meaning "delete this key"
   *  in the merged map — matches application/merge-patch+json behaviour).
   *  Returns the updated object. */
  patch(
    kind: string,
    namespace: string | undefined,
    name: string,
    patch: Record<string, any>,
  ): K8sObject | null {
    const existing = this.get(kind, namespace, name);
    if (!existing) return null;
    const merged = mergePatch(existing, patch) as K8sObject;
    return this.upsert(merged);
  }

  // ── Watch subscriptions ──────────────────────────────────────────────────

  watch(
    kind: string,
    opts: { namespace?: string; fieldName?: string } = {},
    handler: WatchHandler,
  ): () => void {
    const id = this.nextWatcherId++;
    this.watchers.push({ id, kind, namespace: opts.namespace, fieldName: opts.fieldName, handler });
    return () => {
      this.watchers = this.watchers.filter((w) => w.id !== id);
    };
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  subscribeLogs(
    namespace: string,
    podName: string,
    container: string | undefined,
    handler: (line: string) => void,
  ): () => void {
    const id = this.nextWatcherId++;
    this.logSubs.push({ id, namespace, podName, container, handler });
    // Emit a tiny backlog immediately so the screen isn't empty.
    for (let i = 0; i < 5; i++) {
      handler(this.fakeLogLine(podName, container, -i * 1500));
    }
    return () => {
      this.logSubs = this.logSubs.filter((s) => s.id !== id);
    };
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  /** Current CPU/memory usage for a pod. Returns the raw container-array shape
   *  metrics.k8s.io would return. */
  podMetrics(namespace: string, name: string): any {
    const pod = this.get('Pod', namespace, name);
    if (!pod) return null;
    const t = Date.now();
    const containers: any[] = ((pod.spec as any)?.containers ?? []).map((c: any) => {
      const cpuGen = this.lazyPodCpu(name + ':' + c.name);
      const memGen = this.lazyPodMem(name + ':' + c.name);
      return {
        name: c.name,
        usage: {
          cpu: `${Math.max(1, Math.round(cpuGen(t)))}m`,
          memory: `${Math.max(8, Math.round(memGen(t)))}Mi`,
        },
      };
    });
    return {
      apiVersion: 'metrics.k8s.io/v1beta1',
      kind: 'PodMetrics',
      metadata: {
        name,
        namespace,
        creationTimestamp: new Date(t).toISOString(),
      },
      timestamp: new Date(t).toISOString(),
      window: '10s',
      containers,
    };
  }

  listPodMetrics(namespace?: string): any {
    const items = this.list('Pod', namespace).map((p) => this.podMetrics(p.metadata.namespace!, p.metadata.name)).filter(Boolean);
    return { apiVersion: 'metrics.k8s.io/v1beta1', kind: 'PodMetricsList', items };
  }

  nodeMetrics(name: string): any {
    const node = this.get('Node', undefined, name);
    if (!node) return null;
    const t = Date.now();
    const cpuGen = this.lazyNodeCpu(name);
    const memGen = this.lazyNodeMem(name);
    return {
      apiVersion: 'metrics.k8s.io/v1beta1',
      kind: 'NodeMetrics',
      metadata: { name, creationTimestamp: new Date(t).toISOString() },
      timestamp: new Date(t).toISOString(),
      window: '10s',
      usage: {
        cpu: `${Math.round(cpuGen(t))}m`,
        memory: `${Math.round(memGen(t))}Mi`,
      },
    };
  }

  listNodeMetrics(): any {
    const items = this.list('Node').map((n) => this.nodeMetrics(n.metadata.name)).filter(Boolean);
    return { apiVersion: 'metrics.k8s.io/v1beta1', kind: 'NodeMetricsList', items };
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private upsertQuiet(obj: K8sObject) {
    let m = this.byKind.get(obj.kind);
    if (!m) {
      m = new Map();
      this.byKind.set(obj.kind, m);
    }
    m.set(this.key(obj.metadata.namespace, obj.metadata.name), obj);
  }

  private key(namespace: string | undefined, name: string): string {
    return `${namespace ?? ''}/${name}`;
  }

  private fire(type: WatchEvent['type'], obj: K8sObject) {
    // Async dispatch — matches the real client (events come from a network
    // stream, not synchronously in response to the action that caused them).
    setTimeout(() => {
      for (const sub of this.watchers) {
        if (sub.kind !== obj.kind) continue;
        if (sub.namespace && obj.metadata.namespace !== sub.namespace) continue;
        if (sub.fieldName && obj.metadata.name !== sub.fieldName) continue;
        try {
          sub.handler({ type, object: obj });
        } catch {
          /* swallow — one bad handler shouldn't poison the rest */
        }
      }
    }, 0);
  }

  private lazyPodCpu(key: string) {
    let g = this.podCpu.get(key);
    if (!g) {
      g = oscillator(key, [20, 350], 45);
      this.podCpu.set(key, g);
    }
    return g;
  }
  private lazyPodMem(key: string) {
    let g = this.podMem.get(key);
    if (!g) {
      g = oscillator(key + ':mem', [80, 220], 90);
      this.podMem.set(key, g);
    }
    return g;
  }
  private lazyNodeCpu(key: string) {
    let g = this.nodeCpu.get(key);
    if (!g) {
      g = oscillator(key, [600, 2600], 60);
      this.nodeCpu.set(key, g);
    }
    return g;
  }
  private lazyNodeMem(key: string) {
    let g = this.nodeMem.get(key);
    if (!g) {
      g = oscillator(key + ':mem', [2200, 5600], 120);
      this.nodeMem.set(key, g);
    }
    return g;
  }

  // ── Background mutation tick ─────────────────────────────────────────────

  private startTick() {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      // Cheap perturbation — bump a random pod's restartCount with low
      // probability, just enough that someone watching the screen notices
      // the number change. Also fires a MODIFIED watch event so the UI
      // re-renders without a manual refresh.
      const pods = this.list('Pod').filter(
        (p) => (p.status as any)?.phase === 'Running' && (p.metadata.namespace ?? '') !== 'kube-system',
      );
      if (pods.length === 0) return;

      // ~1-in-12 chance per tick to bump one pod's restart count, so on a
      // 5s tick we get a visible "restart" roughly once a minute.
      if (Math.random() < 1 / 12) {
        const pod = pods[Math.floor(Math.random() * pods.length)];
        const cs: any[] = (pod.status as any)?.containerStatuses ?? [];
        if (cs.length > 0) {
          const next: K8sObject = {
            ...pod,
            status: {
              ...(pod.status as any),
              containerStatuses: cs.map((s) => ({
                ...s,
                restartCount: (s.restartCount ?? 0) + 1,
              })),
            },
          } as K8sObject;
          this.upsert(next);
        }
      }
    }, 5000);
  }

  private startLogTick() {
    if (this.logHandle) return;
    this.logHandle = setInterval(() => {
      for (const sub of this.logSubs) {
        if (Math.random() < 0.6) {
          sub.handler(this.fakeLogLine(sub.podName, sub.container));
        }
      }
    }, 1200);
  }

  private fakeLogLine(podName: string, container: string | undefined, msOffset = 0): string {
    const ts = new Date(Date.now() + msOffset).toISOString();
    const cnt = container ? `[${container}] ` : '';
    const lines = [
      `${ts} ${cnt}GET /api/v1/health 200 12ms`,
      `${ts} ${cnt}cache hit key=users:42 ttl=300s`,
      `${ts} ${cnt}info: connection accepted from 10.244.1.${Math.floor(Math.random() * 250)}`,
      `${ts} ${cnt}metric: heap_used=${Math.floor(Math.random() * 100) + 100}MB rss=${Math.floor(Math.random() * 200) + 200}MB`,
      `${ts} ${cnt}debug: processed 1 message from queue (took ${Math.floor(Math.random() * 50) + 5}ms)`,
      `${ts} ${cnt}info: lease renewed (holder=${podName})`,
      `${ts} ${cnt}warn: slow query (217ms) on table=users index=email`,
      `${ts} ${cnt}info: gc cycle complete freed=${Math.floor(Math.random() * 50) + 10}MB`,
    ];
    return lines[Math.floor(Math.random() * lines.length)] + '\n';
  }

  /** Useful for tests / hot-reload. */
  stop() {
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.logHandle) clearInterval(this.logHandle);
    this.tickHandle = null;
    this.logHandle = null;
  }
}

// Deep-merge that treats `null` values in `patch` as deletions on the merged
// side (RFC 7396 JSON Merge Patch). Used by demo patches so Secret/ConfigMap
// edits work end-to-end without the demo client knowing about content types.
function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  const out: any = { ...(typeof target === 'object' && target !== null && !Array.isArray(target) ? target : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      out[k] = mergePatch(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Singleton — first access lazily constructs the store + starts the tick.
let SINGLETON: DemoStore | null = null;
export function demoStore(): DemoStore {
  if (!SINGLETON) SINGLETON = new DemoStore();
  return SINGLETON;
}

export type { DemoStore };
