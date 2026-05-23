// Pure helpers for translating a Pod's spec/status into things the detail
// screen can render. No React, no styling — just data shaping.

import type { K8sObject } from './types';

export type VolumeSource = {
  /** Short display label for the source class (configMap, secret, pvc, …). */
  type: string;
  /** Resource reference if the source maps to a navigable object. */
  ref?: { kind: string; name: string };
  /** Free-form one-liner (host path, NFS server:path, emptyDir medium, …). */
  detail?: string;
};

/** Built-in kind → URL slug, scoped to the references a Pod can carry. */
export const KIND_TO_SLUG: Record<string, string> = {
  Secret: 'secrets',
  ConfigMap: 'configmaps',
  PersistentVolumeClaim: 'persistentvolumeclaims',
  ServiceAccount: 'serviceaccounts',
  Node: 'nodes',
};

/**
 * Resolve a Kubernetes downward-API fieldPath against the pod object.
 * Handles dotted paths (`metadata.name`, `status.podIP`) and the bracketed
 * label / annotation form (`metadata.labels['app.kubernetes.io/name']`).
 * Returns undefined when the path can't be resolved (e.g. the field hasn't
 * been populated yet, or it's a non-scalar like a map).
 */
export function resolveFieldPath(pod: K8sObject, path: string): string | undefined {
  const labels = /^metadata\.labels\['([^']+)'\]$/.exec(path);
  if (labels) return pod.metadata.labels?.[labels[1]];
  const annots = /^metadata\.annotations\['([^']+)'\]$/.exec(path);
  if (annots) return pod.metadata.annotations?.[annots[1]];
  const parts = path.split('.');
  let cur: any = pod;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined || cur === null) return undefined;
  }
  return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : undefined;
}

/**
 * Identify the source of a pod volume entry. We special-case the common
 * volume kinds; everything else falls back to whichever non-`name` key the
 * volume carries, which gives a useful label without enumerating every CSI
 * variant ever invented.
 */
export function identifyVolumeSource(v: any): VolumeSource {
  if (v.configMap) {
    return { type: 'configMap', ref: { kind: 'ConfigMap', name: v.configMap.name } };
  }
  if (v.secret) {
    // The Volume schema's field is `secretName` (not `name`) — easy footgun.
    return { type: 'secret', ref: { kind: 'Secret', name: v.secret.secretName } };
  }
  if (v.persistentVolumeClaim) {
    return {
      type: 'pvc',
      ref: { kind: 'PersistentVolumeClaim', name: v.persistentVolumeClaim.claimName },
      detail: v.persistentVolumeClaim.readOnly ? 'read-only' : undefined,
    };
  }
  if (v.emptyDir) {
    const bits: string[] = [];
    if (v.emptyDir.medium) bits.push(`medium=${v.emptyDir.medium}`);
    if (v.emptyDir.sizeLimit) bits.push(`limit=${v.emptyDir.sizeLimit}`);
    return { type: 'emptyDir', detail: bits.join(' ') || undefined };
  }
  if (v.hostPath) return { type: 'hostPath', detail: v.hostPath.path };
  if (v.projected) {
    return { type: 'projected', detail: `${v.projected.sources?.length ?? 0} sources` };
  }
  if (v.downwardAPI) return { type: 'downwardAPI' };
  if (v.nfs) return { type: 'nfs', detail: `${v.nfs.server}:${v.nfs.path}` };
  if (v.csi) return { type: 'csi', detail: v.csi.driver };
  if (v.iscsi) return { type: 'iscsi', detail: `${v.iscsi.targetPortal}/${v.iscsi.iqn}` };
  if (v.ephemeral) return { type: 'ephemeral' };
  // Last-resort: pick the first non-`name` field as the type label so new /
  // exotic volume kinds at least surface a useful name.
  const keys = Object.keys(v).filter((k) => k !== 'name');
  return { type: keys[0] || 'unknown' };
}

/** Render a probe definition as a one-line summary. */
export function probeToText(probe: any): string {
  if (!probe) return '';
  let action = 'unknown';
  if (probe.httpGet) {
    const scheme = probe.httpGet.scheme ? `${String(probe.httpGet.scheme).toLowerCase()}://` : '';
    const host = probe.httpGet.host ?? '';
    action = `${scheme}${host}:${probe.httpGet.port}${probe.httpGet.path ?? ''}`;
  } else if (probe.tcpSocket) {
    action = `tcp :${probe.tcpSocket.port}`;
  } else if (probe.exec) {
    action = `exec ${(probe.exec.command ?? []).join(' ')}`;
  } else if (probe.grpc) {
    action = `grpc :${probe.grpc.port}${probe.grpc.service ? `/${probe.grpc.service}` : ''}`;
  }
  const timing: string[] = [];
  if (probe.initialDelaySeconds) timing.push(`delay ${probe.initialDelaySeconds}s`);
  if (probe.periodSeconds) timing.push(`every ${probe.periodSeconds}s`);
  if (probe.timeoutSeconds) timing.push(`timeout ${probe.timeoutSeconds}s`);
  if (probe.failureThreshold && probe.failureThreshold !== 3) {
    timing.push(`fail ${probe.failureThreshold}`);
  }
  return timing.length ? `${action}  (${timing.join(', ')})` : action;
}

/** Render a toleration as a one-liner that reads like the kubectl describe form. */
export function tolerationToText(t: any): string {
  // Default operator is Equal; default effect is "all effects".
  if (!t.key && !t.operator) return 'tolerate all';
  const op = t.operator ?? 'Equal';
  const lhs = t.key ?? '*';
  const rhs = op === 'Exists' ? '' : `=${t.value ?? ''}`;
  const effect = t.effect ? `:${t.effect}` : '';
  const seconds =
    t.tolerationSeconds !== undefined ? ` for ${t.tolerationSeconds}s` : '';
  return `${lhs}${rhs}${effect}${seconds}`;
}
