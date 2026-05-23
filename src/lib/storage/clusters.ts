import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { ClusterConnection } from '../k8s/client';

// Non-sensitive cluster metadata lives in AsyncStorage; tokens / passwords live in SecureStore
// keyed by cluster id. We never log the secret values.

const CLUSTER_INDEX_KEY = 'k8s.clusters.index.v1';
const ACTIVE_CLUSTER_KEY = 'k8s.clusters.active.v1';
const ACTIVE_NAMESPACE_KEY = 'k8s.clusters.namespace.v1';
const SECRET_PREFIX = 'k8s.cluster.secret.';

// Secrets (token, password, PKCS12 client identity) are written to SecureStore.
// Everything else is stable cluster metadata in AsyncStorage.
type SerializableCluster = Omit<
  ClusterConnection,
  'token' | 'password' | 'pkcs12Base64' | 'pkcs12Password'
>;

type StoredSecret = {
  token?: string;
  password?: string;
  pkcs12Base64?: string;
  pkcs12Password?: string;
};

export async function listClusters(): Promise<ClusterConnection[]> {
  const raw = await AsyncStorage.getItem(CLUSTER_INDEX_KEY);
  if (!raw) return [];
  let metas: SerializableCluster[] = [];
  try {
    metas = JSON.parse(raw);
  } catch {
    return [];
  }
  // Re-hydrate secrets per cluster.
  const out: ClusterConnection[] = [];
  for (const meta of metas) {
    const secretJson = await SecureStore.getItemAsync(SECRET_PREFIX + meta.id);
    let secret: StoredSecret = {};
    if (secretJson) {
      try {
        secret = JSON.parse(secretJson);
      } catch {}
    }
    out.push({
      ...meta,
      token: secret.token,
      password: secret.password,
      pkcs12Base64: secret.pkcs12Base64,
      pkcs12Password: secret.pkcs12Password,
    });
  }
  return out;
}

function splitSecrets(c: ClusterConnection): { meta: SerializableCluster; secret: StoredSecret } {
  const { token, password, pkcs12Base64, pkcs12Password, ...meta } = c;
  return {
    meta,
    secret: { token, password, pkcs12Base64, pkcs12Password },
  };
}

export async function saveCluster(c: ClusterConnection): Promise<void> {
  const existing = await listClusters();
  const others = existing.filter((e) => e.id !== c.id);
  const next = [...others, c];
  const metas: SerializableCluster[] = next.map((x) => splitSecrets(x).meta);
  await AsyncStorage.setItem(CLUSTER_INDEX_KEY, JSON.stringify(metas));
  const { secret } = splitSecrets(c);
  const hasSecret = !!(secret.token || secret.password || secret.pkcs12Base64);
  if (hasSecret) {
    await SecureStore.setItemAsync(SECRET_PREFIX + c.id, JSON.stringify(secret));
  } else {
    await SecureStore.deleteItemAsync(SECRET_PREFIX + c.id).catch(() => {});
  }
}

export async function deleteCluster(id: string): Promise<void> {
  const existing = await listClusters();
  const next = existing.filter((e) => e.id !== id);
  const metas: SerializableCluster[] = next.map((x) => splitSecrets(x).meta);
  await AsyncStorage.setItem(CLUSTER_INDEX_KEY, JSON.stringify(metas));
  await SecureStore.deleteItemAsync(SECRET_PREFIX + id).catch(() => {});
  const active = await getActiveClusterId();
  if (active === id) await setActiveClusterId(next[0]?.id);
}

export async function getActiveClusterId(): Promise<string | undefined> {
  return (await AsyncStorage.getItem(ACTIVE_CLUSTER_KEY)) ?? undefined;
}

export async function setActiveClusterId(id?: string): Promise<void> {
  if (id) await AsyncStorage.setItem(ACTIVE_CLUSTER_KEY, id);
  else await AsyncStorage.removeItem(ACTIVE_CLUSTER_KEY);
}

export async function getActiveNamespace(): Promise<string | undefined> {
  return (await AsyncStorage.getItem(ACTIVE_NAMESPACE_KEY)) ?? undefined;
}

export async function setActiveNamespace(ns?: string): Promise<void> {
  if (ns) await AsyncStorage.setItem(ACTIVE_NAMESPACE_KEY, ns);
  else await AsyncStorage.removeItem(ACTIVE_NAMESPACE_KEY);
}

export function generateClusterId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
