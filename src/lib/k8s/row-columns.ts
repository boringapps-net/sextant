// Table column definitions per kind. Modelled after the columns kubectl shows
// in `kubectl get <kind>`, with status dot derived separately via row-summaries.
//
// The renderer in ResourceTable hides lower-priority columns when width is
// tight (priority 1 = always show, higher = drop first).

import { age } from '../util/time';
import type { K8sObject } from './types';

export type Column<T = K8sObject> = {
  key: string;
  label: string;
  // String renderer. Tables show plain text in cells.
  render: (obj: T) => string;
  // Flex weight inside the row. Defaults to 1.
  weight?: number;
  // Soft minimum px the cell needs to read comfortably. Used for hide order.
  minWidth?: number;
  // Use a monospace font (IPs, hashes).
  mono?: boolean;
  align?: 'left' | 'right';
  // 1 = essential, 5 = drop first.
  priority?: number;
};

const fmt = (v: unknown): string => (v == null ? '—' : String(v));

function podReady(obj: K8sObject): string {
  const cs: any[] = (obj.status as any)?.containerStatuses ?? [];
  const r = cs.filter((c) => c.ready).length;
  return `${r}/${cs.length}`;
}

function podStatus(obj: K8sObject): string {
  const status: any = obj.status ?? {};
  const cs: any[] = status.containerStatuses ?? [];
  const waiting = cs.find((c) => c.state?.waiting)?.state?.waiting?.reason;
  const terminated = cs.find((c) => c.state?.terminated)?.state?.terminated?.reason;
  return waiting ?? terminated ?? status.phase ?? '—';
}

function podRestarts(obj: K8sObject): string {
  const cs: any[] = (obj.status as any)?.containerStatuses ?? [];
  return String(cs.reduce((n, c) => n + (c.restartCount || 0), 0));
}

function deploymentReady(obj: K8sObject): string {
  const s: any = obj.status ?? {};
  const sp: any = obj.spec ?? {};
  return `${s.readyReplicas ?? 0}/${sp.replicas ?? 0}`;
}

function nodeStatus(obj: K8sObject): string {
  const conds: any[] = (obj.status as any)?.conditions ?? [];
  const ready = conds.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return 'Ready';
  return ready?.reason ?? 'NotReady';
}

function nodeRoles(obj: K8sObject): string {
  const labels = obj.metadata.labels ?? {};
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
    .filter(Boolean);
  return roles.length ? roles.sort().join(',') : '<none>';
}

function nodeInternalIP(obj: K8sObject): string {
  const addrs: any[] = (obj.status as any)?.addresses ?? [];
  return addrs.find((a) => a.type === 'InternalIP')?.address ?? '—';
}

function servicePorts(obj: K8sObject): string {
  const ports: any[] = (obj.spec as any)?.ports ?? [];
  return (
    ports
      .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
      .join(',') || '—'
  );
}

function serviceExternalIP(obj: K8sObject): string {
  const spec: any = obj.spec ?? {};
  const status: any = obj.status ?? {};
  if (spec.externalIPs?.length) return spec.externalIPs.join(',');
  if (status.loadBalancer?.ingress?.length) {
    return status.loadBalancer.ingress.map((i: any) => i.ip ?? i.hostname).join(',');
  }
  return spec.type === 'LoadBalancer' ? '<pending>' : '<none>';
}

const COLS_NAME_NS: Column[] = [
  {
    key: 'name',
    label: 'Name',
    render: (o) => o.metadata.name,
    weight: 3,
    minWidth: 140,
    priority: 1,
  },
  {
    key: 'namespace',
    label: 'Namespace',
    render: (o) => fmt(o.metadata.namespace),
    weight: 2,
    minWidth: 100,
    priority: 3,
  },
];

const COL_AGE: Column = {
  key: 'age',
  label: 'Age',
  render: (o) => age(o.metadata.creationTimestamp),
  weight: 1,
  minWidth: 60,
  align: 'right',
  priority: 1,
};

const DEFAULTS: Column[] = [
  COLS_NAME_NS[0],
  COLS_NAME_NS[1],
  COL_AGE,
];

const REGISTRY: Record<string, Column[]> = {
  Pod: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'ready', label: 'Ready', render: podReady, weight: 1, minWidth: 60, align: 'right', priority: 1 },
    { key: 'status', label: 'Status', render: podStatus, weight: 2, minWidth: 90, priority: 1 },
    { key: 'restarts', label: 'Restarts', render: podRestarts, weight: 1, minWidth: 60, align: 'right', priority: 2 },
    COL_AGE,
    { key: 'node', label: 'Node', render: (o) => fmt((o.spec as any)?.nodeName), weight: 2, minWidth: 120, priority: 4 },
    { key: 'ip', label: 'IP', render: (o) => fmt((o.status as any)?.podIP), weight: 2, minWidth: 110, mono: true, priority: 5 },
  ],

  Deployment: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'ready', label: 'Ready', render: deploymentReady, weight: 1, minWidth: 70, align: 'right', priority: 1 },
    { key: 'updated', label: 'Up-to-date', render: (o) => fmt((o.status as any)?.updatedReplicas ?? 0), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    { key: 'available', label: 'Available', render: (o) => fmt((o.status as any)?.availableReplicas ?? 0), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    COL_AGE,
  ],

  StatefulSet: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'ready', label: 'Ready', render: deploymentReady, weight: 1, minWidth: 70, align: 'right', priority: 1 },
    COL_AGE,
  ],

  ReplicaSet: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'desired', label: 'Desired', render: (o) => fmt((o.spec as any)?.replicas ?? 0), weight: 1, minWidth: 60, align: 'right', priority: 1 },
    { key: 'current', label: 'Current', render: (o) => fmt((o.status as any)?.replicas ?? 0), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    { key: 'ready', label: 'Ready', render: (o) => fmt((o.status as any)?.readyReplicas ?? 0), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    COL_AGE,
  ],

  DaemonSet: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'desired', label: 'Desired', render: (o) => fmt((o.status as any)?.desiredNumberScheduled), weight: 1, minWidth: 60, align: 'right', priority: 1 },
    { key: 'current', label: 'Current', render: (o) => fmt((o.status as any)?.currentNumberScheduled), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    { key: 'ready', label: 'Ready', render: (o) => fmt((o.status as any)?.numberReady), weight: 1, minWidth: 60, align: 'right', priority: 1 },
    COL_AGE,
  ],

  Job: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'completions', label: 'Completions', render: (o) => `${(o.status as any)?.succeeded ?? 0}/${(o.spec as any)?.completions ?? '—'}`, weight: 1, minWidth: 90, align: 'right', priority: 1 },
    { key: 'duration', label: 'Duration', render: (o) => {
      const s = (o.status as any)?.startTime;
      const e = (o.status as any)?.completionTime;
      if (!s) return '—';
      const start = new Date(s).getTime();
      const end = e ? new Date(e).getTime() : Date.now();
      const sec = Math.max(0, Math.round((end - start) / 1000));
      return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
    }, weight: 1, minWidth: 60, align: 'right', priority: 3 },
    COL_AGE,
  ],

  CronJob: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'schedule', label: 'Schedule', render: (o) => fmt((o.spec as any)?.schedule), weight: 2, minWidth: 110, mono: true, priority: 1 },
    { key: 'suspend', label: 'Suspend', render: (o) => ((o.spec as any)?.suspend ? 'true' : 'false'), weight: 1, minWidth: 70, priority: 2 },
    { key: 'active', label: 'Active', render: (o) => String(((o.status as any)?.active ?? []).length), weight: 1, minWidth: 60, align: 'right', priority: 3 },
    { key: 'last', label: 'Last Schedule', render: (o) => age((o.status as any)?.lastScheduleTime), weight: 1, minWidth: 80, align: 'right', priority: 3 },
    COL_AGE,
  ],

  Service: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'type', label: 'Type', render: (o) => fmt((o.spec as any)?.type), weight: 1, minWidth: 100, priority: 1 },
    { key: 'cip', label: 'Cluster IP', render: (o) => fmt((o.spec as any)?.clusterIP), weight: 2, minWidth: 110, mono: true, priority: 2 },
    { key: 'eip', label: 'External IP', render: serviceExternalIP, weight: 2, minWidth: 110, mono: true, priority: 3 },
    { key: 'ports', label: 'Ports', render: servicePorts, weight: 3, minWidth: 130, mono: true, priority: 2 },
    COL_AGE,
  ],

  Ingress: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'class', label: 'Class', render: (o) => fmt((o.spec as any)?.ingressClassName), weight: 1, minWidth: 80, priority: 2 },
    { key: 'hosts', label: 'Hosts', render: (o) => {
      const rules: any[] = (o.spec as any)?.rules ?? [];
      return rules.map((r) => r.host).filter(Boolean).join(', ') || '—';
    }, weight: 3, minWidth: 140, priority: 1 },
    { key: 'addr', label: 'Address', render: (o) => {
      const ing: any[] = (o.status as any)?.loadBalancer?.ingress ?? [];
      return ing.map((i) => i.ip ?? i.hostname).join(', ') || '—';
    }, weight: 2, minWidth: 110, mono: true, priority: 3 },
    COL_AGE,
  ],

  ConfigMap: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'data', label: 'Data', render: (o) => String(Object.keys(o.data ?? {}).length), weight: 1, minWidth: 60, align: 'right', priority: 1 },
    COL_AGE,
  ],

  Secret: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'type', label: 'Type', render: (o) => fmt(o.type), weight: 2, minWidth: 130, priority: 1 },
    { key: 'data', label: 'Data', render: (o) => String(Object.keys(o.data ?? {}).length), weight: 1, minWidth: 60, align: 'right', priority: 2 },
    COL_AGE,
  ],

  PersistentVolumeClaim: [
    COLS_NAME_NS[0],
    COLS_NAME_NS[1],
    { key: 'status', label: 'Status', render: (o) => fmt((o.status as any)?.phase), weight: 1, minWidth: 90, priority: 1 },
    { key: 'volume', label: 'Volume', render: (o) => fmt((o.spec as any)?.volumeName), weight: 2, minWidth: 140, mono: true, priority: 3 },
    { key: 'cap', label: 'Capacity', render: (o) => fmt((o.status as any)?.capacity?.storage), weight: 1, minWidth: 70, align: 'right', priority: 1 },
    { key: 'modes', label: 'Modes', render: (o) => ((o.spec as any)?.accessModes ?? []).join(','), weight: 1, minWidth: 70, priority: 3 },
    { key: 'class', label: 'Storage class', render: (o) => fmt((o.spec as any)?.storageClassName), weight: 1, minWidth: 110, priority: 4 },
    COL_AGE,
  ],

  PersistentVolume: [
    {
      key: 'name',
      label: 'Name',
      render: (o) => o.metadata.name,
      weight: 3,
      minWidth: 160,
      mono: true,
      priority: 1,
    },
    { key: 'cap', label: 'Capacity', render: (o) => fmt((o.spec as any)?.capacity?.storage), weight: 1, minWidth: 70, align: 'right', priority: 1 },
    { key: 'modes', label: 'Modes', render: (o) => ((o.spec as any)?.accessModes ?? []).join(','), weight: 1, minWidth: 70, priority: 2 },
    { key: 'reclaim', label: 'Reclaim', render: (o) => fmt((o.spec as any)?.persistentVolumeReclaimPolicy), weight: 1, minWidth: 80, priority: 3 },
    { key: 'status', label: 'Status', render: (o) => fmt((o.status as any)?.phase), weight: 1, minWidth: 80, priority: 1 },
    { key: 'class', label: 'Storage class', render: (o) => fmt((o.spec as any)?.storageClassName), weight: 1, minWidth: 110, priority: 3 },
    COL_AGE,
  ],

  Node: [
    {
      key: 'name',
      label: 'Name',
      render: (o) => o.metadata.name,
      weight: 3,
      minWidth: 160,
      priority: 1,
    },
    { key: 'status', label: 'Status', render: nodeStatus, weight: 1, minWidth: 90, priority: 1 },
    { key: 'roles', label: 'Roles', render: nodeRoles, weight: 1, minWidth: 100, priority: 2 },
    { key: 'age', label: 'Age', render: (o) => age(o.metadata.creationTimestamp), weight: 1, minWidth: 60, align: 'right', priority: 1 },
    { key: 'version', label: 'Version', render: (o) => fmt((o.status as any)?.nodeInfo?.kubeletVersion), weight: 1, minWidth: 90, priority: 2 },
    { key: 'ip', label: 'Internal IP', render: nodeInternalIP, weight: 2, minWidth: 120, mono: true, priority: 3 },
    { key: 'os', label: 'OS', render: (o) => fmt((o.status as any)?.nodeInfo?.osImage), weight: 2, minWidth: 140, priority: 4 },
  ],

  Namespace: [
    {
      key: 'name',
      label: 'Name',
      render: (o) => o.metadata.name,
      weight: 3,
      minWidth: 160,
      priority: 1,
    },
    { key: 'status', label: 'Status', render: (o) => fmt((o.status as any)?.phase), weight: 1, minWidth: 90, priority: 1 },
    COL_AGE,
  ],

  Event: [
    { key: 'reason', label: 'Reason', render: (o) => fmt((o as any).reason), weight: 1, minWidth: 110, priority: 1 },
    { key: 'object', label: 'Object', render: (o) => {
      const inv = (o as any).involvedObject ?? {};
      return `${inv.kind ?? '?'}/${inv.name ?? '?'}`;
    }, weight: 2, minWidth: 140, priority: 1 },
    { key: 'message', label: 'Message', render: (o) => fmt((o as any).message), weight: 4, minWidth: 200, priority: 1 },
    { key: 'type', label: 'Type', render: (o) => fmt((o as any).type), weight: 1, minWidth: 70, priority: 2 },
    { key: 'count', label: 'Count', render: (o) => fmt((o as any).count ?? 1), weight: 1, minWidth: 60, align: 'right', priority: 3 },
    { key: 'last', label: 'Last seen', render: (o) => age((o as any).lastTimestamp ?? o.metadata.creationTimestamp), weight: 1, minWidth: 70, align: 'right', priority: 1 },
  ],
};

export function columnsFor(kind: string, namespaced: boolean): Column[] {
  if (REGISTRY[kind]) return REGISTRY[kind];
  // Default: name (+ namespace) + age. Used by CRDs.
  return namespaced ? DEFAULTS : [DEFAULTS[0], COL_AGE];
}
