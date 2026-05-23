import { parse as parseYaml } from 'yaml';

// A parsed kubeconfig — we keep just the fields we use.
export type KubeconfigCluster = {
  name: string;
  server: string;
  caData?: string; // base64 CA bundle
  insecureSkipTLSVerify?: boolean;
  // When set, this hostname is used for cert validation instead of the URL host.
  // Matches kubeconfig's `clusters[].cluster.tls-server-name`.
  tlsServerName?: string;
};

export type KubeconfigUser = {
  name: string;
  token?: string;
  username?: string;
  password?: string;
  clientCertificateData?: string;
  clientKeyData?: string;
  exec?: { command: string; args?: string[]; env?: Record<string, string> };
};

export type KubeconfigContext = {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
};

export type Kubeconfig = {
  clusters: KubeconfigCluster[];
  users: KubeconfigUser[];
  contexts: KubeconfigContext[];
  currentContext?: string;
};

export type ParseResult =
  | { ok: true; config: Kubeconfig }
  | { ok: false; error: string };

export function parseKubeconfig(text: string): ParseResult {
  let raw: any;
  try {
    raw = parseYaml(text);
  } catch (e: any) {
    return { ok: false, error: `Invalid YAML: ${e.message ?? e}` };
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Empty or invalid kubeconfig' };
  }
  if (!Array.isArray(raw.clusters) || !Array.isArray(raw.users) || !Array.isArray(raw.contexts)) {
    return { ok: false, error: 'Missing clusters, users, or contexts' };
  }

  const clusters: KubeconfigCluster[] = raw.clusters.map((c: any) => ({
    name: c.name,
    server: c.cluster?.server,
    caData: c.cluster?.['certificate-authority-data'],
    insecureSkipTLSVerify: c.cluster?.['insecure-skip-tls-verify'] === true,
    tlsServerName: c.cluster?.['tls-server-name'] || undefined,
  }));
  const users: KubeconfigUser[] = raw.users.map((u: any) => ({
    name: u.name,
    token: u.user?.token,
    username: u.user?.username,
    password: u.user?.password,
    clientCertificateData: u.user?.['client-certificate-data'],
    clientKeyData: u.user?.['client-key-data'],
    exec: u.user?.exec
      ? {
          command: u.user.exec.command,
          args: u.user.exec.args,
          env: Object.fromEntries(
            (u.user.exec.env ?? []).map((e: any) => [e.name, e.value]),
          ),
        }
      : undefined,
  }));
  const contexts: KubeconfigContext[] = raw.contexts.map((c: any) => ({
    name: c.name,
    cluster: c.context?.cluster,
    user: c.context?.user,
    namespace: c.context?.namespace,
  }));

  return {
    ok: true,
    config: { clusters, users, contexts, currentContext: raw['current-context'] },
  };
}

export type ContextAuthCapability =
  | { kind: 'token'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'client-cert'; clientCertificatePem: string; clientKeyPem: string }
  | { kind: 'exec-unsupported'; command: string }
  | { kind: 'none' };

// base64-decode (kubeconfig stores cert/key data as base64 of the PEM text).
function b64ToString(b64: string): string {
  try {
    // atob is available in Hermes.
    return globalThis.atob(b64);
  } catch {
    return '';
  }
}

export function authForContext(
  config: Kubeconfig,
  contextName: string,
): { context: KubeconfigContext; cluster: KubeconfigCluster; auth: ContextAuthCapability } | null {
  const context = config.contexts.find((c) => c.name === contextName);
  if (!context) return null;
  const cluster = config.clusters.find((c) => c.name === context.cluster);
  const user = config.users.find((u) => u.name === context.user);
  if (!cluster || !user) return null;

  let auth: ContextAuthCapability;
  if (user.token) {
    auth = { kind: 'token', token: user.token };
  } else if (user.clientCertificateData && user.clientKeyData) {
    auth = {
      kind: 'client-cert',
      clientCertificatePem: b64ToString(user.clientCertificateData),
      clientKeyPem: b64ToString(user.clientKeyData),
    };
  } else if (user.username && user.password) {
    auth = { kind: 'basic', username: user.username, password: user.password };
  } else if (user.exec) {
    auth = { kind: 'exec-unsupported', command: user.exec.command };
  } else {
    auth = { kind: 'none' };
  }

  return { context, cluster, auth };
}
