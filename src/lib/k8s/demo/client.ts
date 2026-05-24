// Demo K8sClient — extends the real client so existing typings + consumers
// just work, but every method that would touch the network is overridden to
// read / write the in-memory DemoStore instead.
//
// The synthetic ClusterConnection has server="demo://sextant"; the
// ClusterProvider uses that prefix to decide whether to instantiate this
// class or the real K8sClient.

import { K8sClient, type ClusterConnection, type ExecHandle } from '../client';
import type {
  APIGroupList,
  APIResourceList,
  K8sList,
  K8sObject,
} from '../types';
import type { WatchEvent } from '../watch';
import type {
  PortForwardCallbacks,
  PortForwardHandle,
  StreamHandle,
} from 'expo-k8s-mtls';
import { demoStore } from './store';

export const DEMO_CLUSTER_ID = 'demo';
export const DEMO_CLUSTER_SERVER = 'demo://sextant';

export function isDemoCluster(conn: ClusterConnection | null | undefined): boolean {
  if (!conn) return false;
  return conn.id === DEMO_CLUSTER_ID || conn.server === DEMO_CLUSTER_SERVER;
}

export function buildDemoCluster(): ClusterConnection {
  return {
    id: DEMO_CLUSTER_ID,
    name: 'Demo cluster',
    server: DEMO_CLUSTER_SERVER,
    defaultNamespace: 'demo-app',
  };
}

// ── Built-in resource catalogue ────────────────────────────────────────────
// Enough of the K8s API surface for the cluster context's discovery code +
// the drawer to find every resource kind in our fixtures. CRDs are an empty
// list — the demo cluster doesn't surface any operators.

const CORE_V1: APIResourceList = {
  groupVersion: 'v1',
  resources: [
    apiRes('Pod', 'pods', true, ['po'], ['log', 'exec', 'portforward']),
    apiRes('Service', 'services', true, ['svc']),
    apiRes('ConfigMap', 'configmaps', true, ['cm']),
    apiRes('Secret', 'secrets', true),
    apiRes('Endpoints', 'endpoints', true, ['ep']),
    apiRes('PersistentVolumeClaim', 'persistentvolumeclaims', true, ['pvc']),
    apiRes('PersistentVolume', 'persistentvolumes', false, ['pv']),
    apiRes('Namespace', 'namespaces', false, ['ns']),
    apiRes('Node', 'nodes', false, ['no']),
    apiRes('Event', 'events', true, ['ev']),
    apiRes('ServiceAccount', 'serviceaccounts', true, ['sa']),
  ],
};

const API_GROUPS: APIGroupList = {
  groups: [
    group('apps', 'apps/v1'),
    group('batch', 'batch/v1'),
    group('networking.k8s.io', 'networking.k8s.io/v1'),
    group('storage.k8s.io', 'storage.k8s.io/v1'),
    group('rbac.authorization.k8s.io', 'rbac.authorization.k8s.io/v1'),
    group('discovery.k8s.io', 'discovery.k8s.io/v1'),
    group('metrics.k8s.io', 'metrics.k8s.io/v1beta1'),
    // CRDs — these surface as Custom resources in the drawer thanks to
    // CRDProvider's discovery loop.
    group('cert-manager.io', 'cert-manager.io/v1'),
    group('argoproj.io', 'argoproj.io/v1alpha1'),
  ],
};

const GROUP_RESOURCES: Record<string, APIResourceList> = {
  'apps/v1': {
    groupVersion: 'apps/v1',
    resources: [
      apiRes('Deployment', 'deployments', true, ['deploy']),
      apiRes('ReplicaSet', 'replicasets', true, ['rs']),
      apiRes('StatefulSet', 'statefulsets', true, ['sts']),
      apiRes('DaemonSet', 'daemonsets', true, ['ds']),
    ],
  },
  'batch/v1': {
    groupVersion: 'batch/v1',
    resources: [
      apiRes('Job', 'jobs', true),
      apiRes('CronJob', 'cronjobs', true, ['cj']),
    ],
  },
  'networking.k8s.io/v1': {
    groupVersion: 'networking.k8s.io/v1',
    resources: [
      apiRes('Ingress', 'ingresses', true, ['ing']),
      apiRes('NetworkPolicy', 'networkpolicies', true, ['netpol']),
    ],
  },
  // ── CRDs — populated by fixtures.ts. The CRD discovery loop in
  //    CRDProvider reads these and adds them to the drawer under Custom.
  'cert-manager.io/v1': {
    groupVersion: 'cert-manager.io/v1',
    resources: [
      apiRes('Certificate', 'certificates', true, ['cert', 'certs']),
      apiRes('Issuer', 'issuers', true),
      apiRes('ClusterIssuer', 'clusterissuers', false),
      apiRes('CertificateRequest', 'certificaterequests', true, ['cr', 'crs']),
    ],
  },
  'argoproj.io/v1alpha1': {
    groupVersion: 'argoproj.io/v1alpha1',
    resources: [
      apiRes('Application', 'applications', true, ['app', 'apps']),
      apiRes('AppProject', 'appprojects', true, ['proj', 'projects']),
    ],
  },
};

function apiRes(
  kind: string,
  plural: string,
  namespaced: boolean,
  shortNames?: string[],
  subresources: string[] = [],
): APIResourceList['resources'][number] {
  return {
    name: plural,
    singularName: kind.toLowerCase(),
    namespaced,
    kind,
    verbs: ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'],
    shortNames,
  };
}

function group(name: string, preferredGV: string) {
  const v = preferredGV.includes('/') ? preferredGV.split('/')[1] : preferredGV;
  return {
    name,
    versions: [{ groupVersion: preferredGV, version: v }],
    preferredVersion: { groupVersion: preferredGV, version: v },
  };
}

// ── DemoK8sClient ──────────────────────────────────────────────────────────

export class DemoK8sClient extends K8sClient {
  constructor() {
    super(buildDemoCluster());
  }

  override async ping(): Promise<{ gitVersion: string; platform: string }> {
    return { gitVersion: 'v1.32.0 (demo)', platform: 'linux/arm64' };
  }

  override async coreAPIResources(): Promise<APIResourceList> {
    return CORE_V1;
  }

  override async apiGroups(): Promise<APIGroupList> {
    return API_GROUPS;
  }

  override async groupResources(groupVersion: string): Promise<APIResourceList> {
    return GROUP_RESOURCES[groupVersion] ?? { groupVersion, resources: [] };
  }

  override async list<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean; kind?: string },
    opts: { namespace?: string; labelSelector?: string; fieldSelector?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<K8sList<T>> {
    const kind = rdef.kind ?? this.pluralToKind(rdef.plural);
    let items = demoStore().list(kind, rdef.namespaced ? opts.namespace : undefined);
    if (opts.labelSelector) {
      const want = parseSelector(opts.labelSelector);
      items = items.filter((o) => labelsMatch(o.metadata.labels, want));
    }
    if (opts.fieldSelector) {
      // Only the kubernetes.io/service-name=X form we ourselves issue from
      // ServicePortChip needs first-class support. Anything else we filter
      // best-effort.
      for (const [k, v] of Object.entries(parseSelector(opts.fieldSelector))) {
        if (k === 'metadata.name') items = items.filter((o) => o.metadata.name === v);
        if (k === 'metadata.namespace') items = items.filter((o) => o.metadata.namespace === v);
      }
    }
    return {
      apiVersion: rdef.apiVersion,
      kind: kind + 'List',
      metadata: { resourceVersion: String(Date.now()) },
      items: items as unknown as T[],
    };
  }

  override async get<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean; kind?: string },
    name: string,
    namespace?: string,
  ): Promise<T> {
    const kind = rdef.kind ?? this.pluralToKind(rdef.plural);
    const obj = demoStore().get(kind, rdef.namespaced ? namespace : undefined, name);
    if (!obj) throw notFound(`${kind.toLowerCase()}/${name}`);
    return obj as unknown as T;
  }

  override watch<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean; kind?: string },
    opts: { namespace?: string; fieldSelector?: string; resourceVersion?: string; allowBookmarks?: boolean } = {},
    callbacks: {
      onEvent: (e: WatchEvent<T>) => void;
      onError?: (err: { name?: string; message: string; status?: number }) => void;
      onDone?: () => void;
    },
  ): StreamHandle {
    const kind = rdef.kind ?? this.pluralToKind(rdef.plural);
    let fieldName: string | undefined;
    if (opts.fieldSelector) {
      const sel = parseSelector(opts.fieldSelector);
      fieldName = sel['metadata.name'];
    }
    const unsub = demoStore().watch(kind, {
      namespace: rdef.namespaced ? opts.namespace : undefined,
      fieldName,
    }, (event) => {
      callbacks.onEvent(event as unknown as WatchEvent<T>);
    });
    return {
      stop() {
        unsub();
      },
    };
  }

  override async patch(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean; kind?: string },
    name: string,
    patch: object,
    options: { namespace?: string; subresource?: string; contentType?: string } = {},
  ): Promise<unknown> {
    const kind = rdef.kind ?? this.pluralToKind(rdef.plural);
    // The "scale" subresource passes a partial spec — for our purposes we
    // just merge it into the parent's spec rather than tracking the
    // subresource separately.
    const merged = options.subresource === 'scale'
      ? { spec: (patch as any).spec }
      : (patch as Record<string, any>);
    const obj = demoStore().patch(kind, rdef.namespaced ? options.namespace : undefined, name, merged);
    if (!obj) throw notFound(`${kind.toLowerCase()}/${name}`);
    return obj;
  }

  override async delete(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean; kind?: string },
    name: string,
    namespace?: string,
  ): Promise<unknown> {
    const kind = rdef.kind ?? this.pluralToKind(rdef.plural);
    const obj = demoStore().delete(kind, rdef.namespaced ? namespace : undefined, name);
    if (!obj) throw notFound(`${kind.toLowerCase()}/${name}`);
    return { kind: 'Status', status: 'Success' };
  }

  override async podLogs(
    namespace: string,
    name: string,
    options: { container?: string; tailLines?: number } = {},
  ): Promise<string> {
    const lines = options.tailLines ?? 50;
    const out: string[] = [];
    const store = demoStore();
    // We don't have a real log buffer, so synthesise N recent lines using
    // the same generator the live stream uses.
    const stop = store.subscribeLogs(namespace, name, options.container, (line) => out.push(line));
    stop();
    return out.slice(0, lines).join('');
  }

  override podLogsStream(
    namespace: string,
    name: string,
    options: { container?: string },
    cb: { onChunk: (text: string) => void; onError?: (err: any) => void; onDone?: (info: { cancelled: boolean }) => void },
  ): StreamHandle {
    const unsub = demoStore().subscribeLogs(namespace, name, options.container, (line) => {
      cb.onChunk(line);
    });
    let stopped = false;
    return {
      stop() {
        if (stopped) return;
        stopped = true;
        unsub();
        cb.onDone?.({ cancelled: true });
      },
    };
  }

  // Metrics

  override async listPodMetrics(namespace?: string): Promise<any> {
    return demoStore().listPodMetrics(namespace);
  }
  override async getPodMetrics(namespace: string, name: string): Promise<any> {
    const m = demoStore().podMetrics(namespace, name);
    if (!m) throw notFound(`pod/${name}`);
    return m;
  }
  override async listNodeMetrics(): Promise<any> {
    return demoStore().listNodeMetrics();
  }
  override async getNodeMetrics(name: string): Promise<any> {
    const m = demoStore().nodeMetrics(name);
    if (!m) throw notFound(`node/${name}`);
    return m;
  }

  // Pod exec — a minimal terminal simulator that recognises a handful of
  // commands so the shell screen feels functional in App Review. Real-
  // looking exec into a demo container isn't possible (there's no container),
  // so we lean into a "demo busybox" persona.
  override podExec(
    namespace: string,
    name: string,
    _options: any,
    cb: {
      onStdout?: (data: Uint8Array) => void;
      onStderr?: (data: Uint8Array) => void;
      onExit?: (status: string) => void;
      onOpen?: () => void;
      onClose?: (info: { code: number; reason: string }) => void;
      onError?: (err: any) => void;
    },
  ): ExecHandle {
    const enc = new TextEncoder();
    const write = (s: string) => cb.onStdout?.(enc.encode(s));
    const prompt = () => write(`\r\n\x1b[36m${name}\x1b[0m:/ # `);

    let line = '';
    let closed = false;

    setTimeout(() => {
      cb.onOpen?.();
      write('\x1b[2J\x1b[H');
      write(`\x1b[1;32mDemo shell\x1b[0m — pod \x1b[36m${name}\x1b[0m  (namespace ${namespace})\r\n`);
      write('This is a simulated environment. Try: ls, ps, top, whoami, cat /etc/os-release, exit\r\n');
      prompt();
    }, 50);

    function handleLine(input: string) {
      const cmd = input.trim();
      if (cmd === '') return;
      const [head, ...args] = cmd.split(/\s+/);
      switch (head) {
        case 'ls': {
          if (args.includes('-la') || args.includes('-l')) {
            write(
              '\r\ntotal 32\r\n' +
              'drwxr-xr-x  1 root root  4096 Jan 24  2026 .\r\n' +
              'drwxr-xr-x  1 root root  4096 Jan 24  2026 ..\r\n' +
              '-rwxr-xr-x  1 root root 12288 Jan 24  2026 app\r\n' +
              'drwxr-xr-x  2 root root  4096 Jan 24  2026 config\r\n' +
              'drwxr-xr-x  2 root root  4096 Jan 24  2026 data\r\n',
            );
          } else {
            write('\r\napp  config  data  etc  lib  proc  sys  tmp  usr  var\r\n');
          }
          break;
        }
        case 'pwd':
          write('\r\n/\r\n');
          break;
        case 'whoami':
          write('\r\nroot\r\n');
          break;
        case 'ps':
          write(
            '\r\nPID   USER     TIME  COMMAND\r\n' +
            '    1 root      0:01 /app\r\n' +
            '    7 root      0:00 sleep infinity\r\n' +
            `   42 root      0:00 sh\r\n`,
          );
          break;
        case 'top':
          write(
            '\r\nMem: 142M used, 884M free, 12M buff, 96M cached\r\n' +
            'CPU: 12% usr   3% sys   0% nic  85% idle   0% io   0% irq   0% sirq\r\n' +
            'Load average: 0.18 0.22 0.21 2/123 42\r\n\r\n' +
            'PID   USER     VSZ %CPU PID  COMMAND\r\n' +
            '    1 root    18m  4.2   1 /app\r\n' +
            '   42 root    1.2m 0.1  42 sh\r\n',
          );
          break;
        case 'cat': {
          const target = args[0] ?? '';
          if (target === '/etc/os-release') {
            write(
              '\r\nNAME="Demo Linux"\r\n' +
              'ID=demo\r\n' +
              'VERSION="1.0 (Sextant)"\r\n' +
              'PRETTY_NAME="Demo Linux 1.0 (Sextant)"\r\n' +
              'HOME_URL="https://sextant.app/"\r\n',
            );
          } else if (target === '/proc/version') {
            write('\r\nLinux version 6.6.0-demo (sextant@demo) #1 SMP\r\n');
          } else {
            write(`\r\ncat: ${target}: No such file or directory\r\n`);
          }
          break;
        }
        case 'echo':
          write(`\r\n${args.join(' ')}\r\n`);
          break;
        case 'date':
          write(`\r\n${new Date().toString()}\r\n`);
          break;
        case 'uname':
          write('\r\nLinux demo-pod 6.6.0-demo #1 SMP aarch64 GNU/Linux\r\n');
          break;
        case 'clear':
          write('\x1b[2J\x1b[H');
          break;
        case 'exit':
        case 'logout': {
          write('\r\n');
          closed = true;
          setTimeout(() => {
            cb.onExit?.('Completed');
            cb.onClose?.({ code: 1000, reason: 'demo-exit' });
          }, 30);
          return;
        }
        case 'help':
          write('\r\nSupported demo commands: ls [-la], ps, top, pwd, whoami, cat /etc/os-release, echo X, date, uname, clear, exit\r\n');
          break;
        default:
          write(`\r\nsh: ${head}: not found  (demo shell — try \x1b[1mhelp\x1b[0m)\r\n`);
      }
    }

    return {
      write(input) {
        if (closed) return;
        const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
        for (const ch of text) {
          const c = ch.charCodeAt(0);
          if (c === 0x03) {
            // Ctrl-C — discard the in-progress line, redraw prompt.
            line = '';
            write('^C');
            prompt();
          } else if (c === 0x7f || c === 0x08) {
            // Backspace
            if (line.length > 0) {
              line = line.slice(0, -1);
              write('\x08 \x08');
            }
          } else if (c === 0x0d || c === 0x0a) {
            // Enter
            const submitted = line;
            line = '';
            handleLine(submitted);
            if (!closed) prompt();
          } else if (c >= 0x20 && c < 0x7f) {
            line += ch;
            write(ch);
          }
        }
      },
      resize() { /* no-op for demo */ },
      close() {
        if (closed) return;
        closed = true;
        cb.onClose?.({ code: 1000, reason: 'demo-close' });
      },
    };
  }

  // Port forward — clearly not available in demo mode. Returns a handle that
  // immediately fires onError + onClosed so the UI shows a useful message
  // instead of spinning.
  override portForward(
    _namespace: string,
    _name: string,
    _port: number,
    cb: PortForwardCallbacks = {},
  ): PortForwardHandle {
    setTimeout(() => {
      cb.onError?.({
        name: 'DemoMode',
        message:
          'Port forwarding is the one feature we can\'t fake in demo mode — there\'s no real pod to forward to. Try the other features (logs, shell, edit configmaps/secrets) and connect a real cluster when you\'re ready.',
      });
      cb.onClosed?.({ reason: 'demo-mode-not-supported' });
    }, 0);
    return {
      id: `demo-pf-${Math.random().toString(36).slice(2, 8)}`,
      stop() { /* no-op */ },
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private pluralToKind(plural: string): string {
    // Inverse of the BUILTIN_RESOURCES table, just enough to cover the kinds
    // our fixtures put in the store. Anything not here returns the plural as
    // a best-effort fallback (callers should pass rdef.kind when they can).
    const map: Record<string, string> = {
      pods: 'Pod',
      services: 'Service',
      deployments: 'Deployment',
      replicasets: 'ReplicaSet',
      statefulsets: 'StatefulSet',
      daemonsets: 'DaemonSet',
      jobs: 'Job',
      cronjobs: 'CronJob',
      configmaps: 'ConfigMap',
      secrets: 'Secret',
      ingresses: 'Ingress',
      endpoints: 'Endpoints',
      endpointslices: 'EndpointSlice',
      persistentvolumeclaims: 'PersistentVolumeClaim',
      persistentvolumes: 'PersistentVolume',
      namespaces: 'Namespace',
      nodes: 'Node',
      events: 'Event',
      serviceaccounts: 'ServiceAccount',
      networkpolicies: 'NetworkPolicy',
      // CRD kinds
      certificates: 'Certificate',
      issuers: 'Issuer',
      clusterissuers: 'ClusterIssuer',
      certificaterequests: 'CertificateRequest',
      applications: 'Application',
      appprojects: 'AppProject',
    };
    return map[plural] ?? plural;
  }
}

// ── Small utilities ────────────────────────────────────────────────────────

function parseSelector(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function labelsMatch(labels: Record<string, string> | undefined, want: Record<string, string>): boolean {
  if (!labels) return Object.keys(want).length === 0;
  for (const [k, v] of Object.entries(want)) {
    if (labels[k] !== v) return false;
  }
  return true;
}

function notFound(target: string): Error {
  const err = new Error(`Not Found: ${target}`);
  (err as any).status = 404;
  return err;
}
