// Per-kind summary builders for list rows. Each returns the secondary text(s)
// to show under the name. Keep this pure — no React.

import { age } from '../util/time';
import type { K8sObject } from './types';

export type RowSummary = {
  primary: string;     // name
  secondary?: string;  // namespace · primary status / image / etc.
  tertiary?: string;   // age etc.
  status?: 'ok' | 'warn' | 'bad' | 'info' | 'muted';
  badges?: string[];
};

function statusBadge(phase?: string): RowSummary['status'] {
  if (phase === 'Running' || phase === 'Active' || phase === 'Bound' || phase === 'Succeeded') return 'ok';
  if (phase === 'Pending') return 'warn';
  if (phase === 'Failed' || phase === 'CrashLoopBackOff' || phase === 'Error') return 'bad';
  return 'muted';
}

export function summarize(kind: string, obj: K8sObject): RowSummary {
  const meta = obj.metadata;
  const ts = age(meta.creationTimestamp);
  const base: RowSummary = {
    primary: meta.name,
    tertiary: ts,
  };
  switch (kind) {
    case 'Pod': {
      const status = obj.status as any;
      const cs: any[] = status?.containerStatuses ?? [];
      const ready = `${cs.filter((c) => c.ready).length}/${cs.length || 0}`;
      const restarts = cs.reduce((n, c) => n + (c.restartCount || 0), 0);
      // Compute a richer "reason" if a container is waiting
      const waitingReason = cs.find((c) => c.state?.waiting)?.state?.waiting?.reason;
      const phase = waitingReason ?? status?.phase ?? '—';
      return {
        ...base,
        secondary: `${meta.namespace ?? ''} · ${phase}`,
        status: statusBadge(phase),
        badges: [`ready ${ready}`, restarts ? `restarts ${restarts}` : ''].filter(Boolean) as string[],
      };
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet': {
      const spec = obj.spec as any;
      const status = obj.status as any;
      const desired = spec?.replicas ?? 0;
      const ready = status?.readyReplicas ?? 0;
      return {
        ...base,
        secondary: `${meta.namespace ?? ''}`,
        status: ready === desired && desired > 0 ? 'ok' : desired === 0 ? 'muted' : 'warn',
        badges: [`${ready}/${desired}`],
      };
    }
    case 'DaemonSet': {
      const s = obj.status as any;
      const desired = s?.desiredNumberScheduled ?? 0;
      const ready = s?.numberReady ?? 0;
      return {
        ...base,
        secondary: meta.namespace,
        status: ready === desired && desired > 0 ? 'ok' : 'warn',
        badges: [`${ready}/${desired}`],
      };
    }
    case 'Job': {
      const s = obj.status as any;
      return {
        ...base,
        secondary: meta.namespace,
        status: s?.succeeded ? 'ok' : s?.failed ? 'bad' : 'warn',
        badges: [
          s?.active ? `active ${s.active}` : '',
          s?.succeeded ? `succeeded ${s.succeeded}` : '',
          s?.failed ? `failed ${s.failed}` : '',
        ].filter(Boolean) as string[],
      };
    }
    case 'CronJob': {
      const spec = obj.spec as any;
      return {
        ...base,
        secondary: `${meta.namespace ?? ''} · ${spec?.schedule ?? ''}`,
        status: spec?.suspend ? 'muted' : 'ok',
      };
    }
    case 'Service': {
      const spec = obj.spec as any;
      return {
        ...base,
        secondary: `${meta.namespace ?? ''} · ${spec?.type ?? ''} ${spec?.clusterIP ?? ''}`,
        status: 'info',
      };
    }
    case 'Ingress': {
      const spec = obj.spec as any;
      const hosts = (spec?.rules ?? []).map((r: any) => r.host).filter(Boolean).join(', ');
      return { ...base, secondary: `${meta.namespace ?? ''} · ${hosts}`, status: 'info' };
    }
    case 'ConfigMap': {
      const keys = Object.keys(obj.data ?? {}).length;
      return { ...base, secondary: `${meta.namespace ?? ''}`, badges: [`${keys} keys`] };
    }
    case 'Secret': {
      const keys = Object.keys(obj.data ?? {}).length;
      return { ...base, secondary: `${meta.namespace ?? ''} · ${obj.type ?? ''}`, badges: [`${keys} keys`] };
    }
    case 'PersistentVolumeClaim': {
      const s = obj.status as any;
      const spec = obj.spec as any;
      const phase = s?.phase ?? '—';
      return {
        ...base,
        secondary: `${meta.namespace ?? ''} · ${phase} · ${spec?.resources?.requests?.storage ?? ''}`,
        status: statusBadge(phase),
      };
    }
    case 'PersistentVolume': {
      const s = obj.status as any;
      const spec = obj.spec as any;
      return {
        ...base,
        secondary: `${spec?.capacity?.storage ?? ''} · ${spec?.accessModes?.join(',') ?? ''}`,
        status: statusBadge(s?.phase),
      };
    }
    case 'Node': {
      const cond = (obj.status as any)?.conditions ?? [];
      const ready = cond.find((c: any) => c.type === 'Ready');
      const isReady = ready?.status === 'True';
      const info = (obj.status as any)?.nodeInfo;
      return {
        ...base,
        secondary: info ? `${info.osImage ?? ''} · ${info.kubeletVersion ?? ''}` : undefined,
        status: isReady ? 'ok' : 'bad',
        badges: [isReady ? 'Ready' : 'NotReady'],
      };
    }
    case 'Namespace': {
      const phase = (obj.status as any)?.phase;
      return { ...base, secondary: phase, status: statusBadge(phase) };
    }
    case 'Event': {
      const ev: any = obj;
      return {
        ...base,
        primary: `${ev.reason ?? ''} on ${ev.involvedObject?.kind ?? ''}/${ev.involvedObject?.name ?? ''}`,
        secondary: ev.message ?? '',
        status: ev.type === 'Warning' ? 'warn' : 'info',
        tertiary: age(ev.lastTimestamp || meta.creationTimestamp),
      };
    }
    default: {
      return { ...base, secondary: meta.namespace };
    }
  }
}
