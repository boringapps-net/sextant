// Helm release decoding + listing.
//
// Helm v3 stores each release as a Kubernetes Secret of type
// helm.sh/release.v1 in the release's namespace. The actual release data
// lives in `data.release`, double-base64-wrapped around a gzip layer:
//
//     secret.data.release   →  (API server returns this base64-encoded)
//       atob()              →  inner base64 string
//         atob()            →  gzipped bytes
//           gunzip()        →  JSON release object
//
// The JSON shape is documented at:
//   https://github.com/helm/helm/blob/main/pkg/release/release.go
//
// We only read the fields we render — chart metadata, status, values,
// manifest, notes, hooks, deployedAt, version.

import { inflate, gzip } from 'pako';
import type { K8sClient } from './client';
import { BUILTIN_RESOURCES, type ResourceDef } from './resources';
import type { K8sObject } from './types';

const SECRET_DEF = BUILTIN_RESOURCES.find((r) => r.kind === 'Secret')!;

// What we surface to the UI. A subset of the full Helm release shape — just
// the parts the list / detail screens actually use.
export type HelmRelease = {
  name: string;
  namespace: string;
  version: number;
  status: 'deployed' | 'superseded' | 'failed' | 'uninstalled' | 'pending-install'
    | 'pending-upgrade' | 'pending-rollback' | 'uninstalling' | string;
  chart: {
    name: string;
    version: string;
    appVersion?: string;
    description?: string;
    icon?: string;
    home?: string;
    sources?: string[];
    keywords?: string[];
  };
  values: Record<string, any>;
  // Default values from the chart (chart.values / chart.metadata).
  defaultValues?: Record<string, any>;
  manifest: string;     // rendered K8s YAML
  notes?: string;       // chart NOTES.txt
  firstDeployed?: string;
  lastDeployed?: string;
  description?: string;
  // Backing Secret so the detail screen can navigate back to it.
  sourceSecretName: string;
};

export type HelmReleaseRaw = {
  name: string;
  info?: {
    status?: string;
    first_deployed?: string;
    last_deployed?: string;
    description?: string;
    notes?: string;
  };
  chart?: {
    metadata?: {
      name?: string;
      version?: string;
      appVersion?: string;
      description?: string;
      icon?: string;
      home?: string;
      sources?: string[];
      keywords?: string[];
    };
    values?: Record<string, any>;
  };
  config?: Record<string, any>;
  manifest?: string;
  version?: number;
  namespace?: string;
};

/**
 * Decode a Secret's `data.release` field into a HelmRelease. Returns null if
 * the secret isn't recognisably a helm.sh/release.v1 payload (so the caller
 * can be lazy about pre-filtering and just hand us any Secret).
 */
export function decodeHelmRelease(secret: K8sObject): HelmRelease | null {
  if (secret.type !== 'helm.sh/release.v1') return null;
  const data = (secret.data ?? {}) as Record<string, string>;
  const release = data['release'];
  if (!release) return null;
  try {
    // K8s already decoded the outer base64 to give us release as the inner
    // base64 string — but our K8sObject keeps secret.data values base64'd
    // (the same shape the API returns). So we need TWO base64 decodes here.
    const innerB64 = atob(release);
    const compressed = base64ToBytes(innerB64);
    const json = new TextDecoder('utf-8').decode(inflate(compressed));
    const raw = JSON.parse(json) as HelmReleaseRaw;
    return rawToRelease(raw, secret.metadata.name);
  } catch {
    return null;
  }
}

/**
 * Build the inverse — JSON release → double-base64-gzip Secret data.release.
 * Used by demo fixtures so the demo cluster's Helm releases survive the same
 * decode path real-cluster releases go through.
 */
export function encodeHelmRelease(raw: HelmReleaseRaw): string {
  const json = JSON.stringify(raw);
  const compressed = gzip(new TextEncoder().encode(json));
  const innerB64 = bytesToBase64(compressed);
  // Outer base64 is applied by whoever puts this into Secret.data (the
  // store does it implicitly for demo fixtures; in real clusters it's the
  // API server). We return the inner-b64 string so callers can wrap once.
  return innerB64;
}

function rawToRelease(raw: HelmReleaseRaw, secretName: string): HelmRelease {
  const meta = raw.chart?.metadata ?? {};
  return {
    name: raw.name ?? '(unnamed)',
    namespace: raw.namespace ?? '',
    version: raw.version ?? 0,
    status: raw.info?.status ?? 'unknown',
    chart: {
      name: meta.name ?? '(unknown)',
      version: meta.version ?? '?',
      appVersion: meta.appVersion,
      description: meta.description,
      icon: meta.icon,
      home: meta.home,
      sources: meta.sources,
      keywords: meta.keywords,
    },
    values: raw.config ?? {},
    defaultValues: raw.chart?.values,
    manifest: raw.manifest ?? '',
    notes: raw.info?.notes,
    firstDeployed: raw.info?.first_deployed,
    lastDeployed: raw.info?.last_deployed,
    description: raw.info?.description,
    sourceSecretName: secretName,
  };
}

/**
 * List Helm releases — for each release name, picks the highest-revision
 * Secret. Falls back to cluster-wide listing if `namespace` is omitted.
 */
export async function listHelmReleases(
  client: K8sClient,
  namespace?: string,
): Promise<HelmRelease[]> {
  const list = await client.list<K8sObject>(SECRET_DEF, {
    namespace,
    labelSelector: 'owner=helm',
  });
  // Group by (namespace, name) — `name` label is the release name; `version`
  // label is the revision number as a string. Keep the highest revision per
  // group.
  const latest: Map<string, K8sObject> = new Map();
  for (const s of list.items) {
    if (s.type !== 'helm.sh/release.v1') continue;
    const labels = s.metadata.labels ?? {};
    const name = labels['name'] ?? s.metadata.name;
    const ns = s.metadata.namespace ?? '';
    const key = `${ns}/${name}`;
    const rev = Number(labels['version'] ?? '0');
    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, s);
      continue;
    }
    const existingRev = Number((existing.metadata.labels ?? {})['version'] ?? '0');
    if (rev > existingRev) latest.set(key, s);
  }
  const releases: HelmRelease[] = [];
  for (const s of latest.values()) {
    const r = decodeHelmRelease(s);
    if (r) releases.push(r);
  }
  // Sort by lastDeployed desc; fallback to name asc.
  releases.sort((a, b) => {
    const ad = a.lastDeployed ? Date.parse(a.lastDeployed) : 0;
    const bd = b.lastDeployed ? Date.parse(b.lastDeployed) : 0;
    if (bd !== ad) return bd - ad;
    return a.name.localeCompare(b.name);
  });
  return releases;
}

/**
 * Get every revision Secret for a single release, decoded, sorted oldest → newest.
 */
export async function getReleaseHistory(
  client: K8sClient,
  namespace: string,
  releaseName: string,
): Promise<HelmRelease[]> {
  const list = await client.list<K8sObject>(SECRET_DEF, {
    namespace,
    labelSelector: `owner=helm,name=${releaseName}`,
  });
  const out: HelmRelease[] = [];
  for (const s of list.items) {
    const r = decodeHelmRelease(s);
    if (r) out.push(r);
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

// ── base64 helpers (Hermes-friendly, no Buffer) ────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  // Chunk so we don't blow String.fromCharCode's argument limit on big
  // payloads (manifests can easily be a few hundred KB).
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}
