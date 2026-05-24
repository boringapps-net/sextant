// Initial K8s fixtures for the demo cluster. Built as plain JSON-shape objects
// (matching what the API server would return) so the UI's normal rendering
// paths work without any demo-specific branching. ~50 resources spread across
// 4 namespaces — enough for App Review to click every screen and see real-
// looking data.
//
// Resources picked for breadth, not depth: at least one example of each kind
// the app surfaces in its drawer, with realistic-ish names / labels /
// annotations / statuses. Avoid making fixtures too long — reviewers spend
// seconds per screen, not minutes.

import type { K8sObject } from '../types';
import { encodeHelmRelease, type HelmReleaseRaw } from '../helm';

// Anchor "now" once per session so creationTimestamp ages look plausible
// (instead of every pod claiming it started 0 seconds ago).
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// ── Helpers ────────────────────────────────────────────────────────────────

function uid(): string {
  return [8, 4, 4, 4, 12]
    .map((n) =>
      Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
    )
    .join('-');
}

function pod(opts: {
  name: string;
  namespace: string;
  generateName?: string;
  labels?: Record<string, string>;
  ownerKind?: string;
  ownerName?: string;
  containers: Array<{
    name: string;
    image: string;
    ports?: Array<{ name?: string; containerPort: number; protocol?: string }>;
    env?: Array<{ name: string; value?: string; valueFrom?: any }>;
    envFrom?: any[];
    volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean; subPath?: string }>;
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
    command?: string[];
    args?: string[];
    livenessProbe?: any;
    readinessProbe?: any;
  }>;
  nodeName?: string;
  podIP?: string;
  phase?: 'Running' | 'Pending' | 'Succeeded' | 'Failed';
  restartCount?: number;
  ageSeconds?: number;
  volumes?: any[];
  serviceAccountName?: string;
  imagePullSecrets?: Array<{ name: string }>;
  qosClass?: string;
}): K8sObject {
  const ageMs = (opts.ageSeconds ?? 3600) * 1000;
  const created = ago(ageMs);
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: created,
      labels: opts.labels ?? {},
      annotations: {},
      ownerReferences: opts.ownerKind
        ? [
            {
              apiVersion: opts.ownerKind === 'ReplicaSet' || opts.ownerKind === 'StatefulSet' || opts.ownerKind === 'DaemonSet' ? 'apps/v1' : 'batch/v1',
              kind: opts.ownerKind,
              name: opts.ownerName!,
              uid: uid(),
              controller: true,
              blockOwnerDeletion: true,
            },
          ]
        : undefined,
    },
    spec: {
      containers: opts.containers,
      nodeName: opts.nodeName ?? 'demo-worker-1',
      restartPolicy: 'Always',
      dnsPolicy: 'ClusterFirst',
      terminationGracePeriodSeconds: 30,
      serviceAccountName: opts.serviceAccountName ?? 'default',
      volumes: opts.volumes ?? [],
      imagePullSecrets: opts.imagePullSecrets,
    },
    status: {
      phase: opts.phase ?? 'Running',
      podIP: opts.podIP ?? `10.244.${Math.floor(Math.random() * 4)}.${Math.floor(Math.random() * 250 + 5)}`,
      hostIP: '10.0.0.10',
      startTime: created,
      qosClass: opts.qosClass ?? 'Burstable',
      conditions: [
        { type: 'PodScheduled', status: 'True' },
        { type: 'Initialized', status: 'True' },
        { type: 'ContainersReady', status: opts.phase === 'Running' ? 'True' : 'False' },
        { type: 'Ready', status: opts.phase === 'Running' ? 'True' : 'False' },
      ],
      containerStatuses: opts.containers.map((c) => ({
        name: c.name,
        image: c.image,
        imageID: `docker-pullable://${c.image}@sha256:${'a'.repeat(64)}`,
        ready: opts.phase === 'Running',
        restartCount: opts.restartCount ?? 0,
        state:
          opts.phase === 'Running'
            ? { running: { startedAt: created } }
            : opts.phase === 'Pending'
            ? { waiting: { reason: 'ContainerCreating' } }
            : { terminated: { reason: 'Completed', exitCode: 0, finishedAt: ago(ageMs - 1000) } },
      })),
    },
  } as unknown as K8sObject;
}

function deployment(opts: {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas?: number;
  labels?: Record<string, string>;
  template: any;
  ageSeconds?: number;
}): K8sObject {
  const ready = opts.readyReplicas ?? opts.replicas;
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago((opts.ageSeconds ?? 86400) * 1000),
      labels: opts.labels ?? { app: opts.name },
      annotations: { 'deployment.kubernetes.io/revision': '1' },
    },
    spec: {
      replicas: opts.replicas,
      selector: { matchLabels: { app: opts.name } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: '25%', maxSurge: '25%' } },
      template: opts.template,
    },
    status: {
      replicas: opts.replicas,
      readyReplicas: ready,
      availableReplicas: ready,
      updatedReplicas: opts.replicas,
      observedGeneration: 1,
      conditions: [
        { type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' },
        { type: 'Progressing', status: 'True', reason: 'NewReplicaSetAvailable' },
      ],
    },
  } as unknown as K8sObject;
}

function replicaSet(opts: {
  name: string;
  namespace: string;
  replicas: number;
  labels: Record<string, string>;
  ownerDeployment: string;
  ageSeconds?: number;
}): K8sObject {
  return {
    apiVersion: 'apps/v1',
    kind: 'ReplicaSet',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago((opts.ageSeconds ?? 86400) * 1000),
      labels: { ...opts.labels, 'pod-template-hash': opts.name.split('-').slice(-1)[0] },
      annotations: { 'deployment.kubernetes.io/revision': '1' },
      ownerReferences: [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          name: opts.ownerDeployment,
          uid: uid(),
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: { replicas: opts.replicas, selector: { matchLabels: opts.labels } },
    status: {
      replicas: opts.replicas,
      readyReplicas: opts.replicas,
      availableReplicas: opts.replicas,
      observedGeneration: 1,
    },
  } as unknown as K8sObject;
}

function service(opts: {
  name: string;
  namespace: string;
  type?: string;
  clusterIP?: string;
  selector?: Record<string, string>;
  ports: Array<{ name?: string; port: number; targetPort?: number | string; protocol?: string; nodePort?: number }>;
}): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 1000),
      labels: { app: opts.name },
    },
    spec: {
      type: opts.type ?? 'ClusterIP',
      clusterIP: opts.clusterIP ?? `10.96.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      selector: opts.selector ?? { app: opts.name },
      ports: opts.ports.map((p) => ({ ...p, protocol: p.protocol ?? 'TCP' })),
    },
    status: { loadBalancer: {} },
  } as unknown as K8sObject;
}

function configMap(name: string, namespace: string, data: Record<string, string>): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name,
      namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 1000),
    },
    data,
  } as unknown as K8sObject;
}

function secret(opts: {
  name: string;
  namespace: string;
  type?: string;
  data: Record<string, string>;
}): K8sObject {
  // The store keeps Secret values as base64 (matches what the API returns).
  const encoded: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.data)) {
    encoded[k] = globalThis.btoa(v);
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: opts.name,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 1000),
    },
    type: opts.type ?? 'Opaque',
    data: encoded,
  } as unknown as K8sObject;
}

function node(opts: {
  name: string;
  ip: string;
  roles?: string[];
  version?: string;
  ageSeconds?: number;
}): K8sObject {
  const labels: Record<string, string> = {
    'kubernetes.io/hostname': opts.name,
    'kubernetes.io/arch': 'arm64',
    'kubernetes.io/os': 'linux',
    'node.kubernetes.io/instance-type': 'demo.small',
    'topology.kubernetes.io/region': 'au-syd',
    'topology.kubernetes.io/zone': 'demo-1',
  };
  for (const r of opts.roles ?? []) {
    labels[`node-role.kubernetes.io/${r}`] = '';
  }
  return {
    apiVersion: 'v1',
    kind: 'Node',
    metadata: {
      name: opts.name,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago((opts.ageSeconds ?? 30 * 86400) * 1000),
      labels,
    },
    spec: { podCIDR: '10.244.0.0/24' },
    status: {
      capacity: { cpu: '4', memory: '8Gi', pods: '110' },
      allocatable: { cpu: '3800m', memory: '7.5Gi', pods: '110' },
      conditions: [
        { type: 'Ready', status: 'True', reason: 'KubeletReady', message: 'kubelet is posting ready status' },
        { type: 'MemoryPressure', status: 'False' },
        { type: 'DiskPressure', status: 'False' },
        { type: 'PIDPressure', status: 'False' },
      ],
      addresses: [
        { type: 'InternalIP', address: opts.ip },
        { type: 'Hostname', address: opts.name },
      ],
      nodeInfo: {
        kubeletVersion: opts.version ?? 'v1.32.0',
        osImage: 'Ubuntu 24.04 LTS',
        operatingSystem: 'linux',
        architecture: 'arm64',
        containerRuntimeVersion: 'containerd://1.7.20',
      },
    },
  } as unknown as K8sObject;
}

function namespace(name: string): K8sObject {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(30 * 86400 * 1000),
      labels: { 'kubernetes.io/metadata.name': name },
    },
    spec: { finalizers: ['kubernetes'] },
    status: { phase: 'Active' },
  } as unknown as K8sObject;
}

// ── Fixture build ──────────────────────────────────────────────────────────

export function buildInitialFixtures(): K8sObject[] {
  const all: K8sObject[] = [];

  // Namespaces
  for (const ns of ['default', 'kube-system', 'demo-app', 'monitoring', 'cert-manager', 'argocd']) {
    all.push(namespace(ns));
  }

  // Nodes
  all.push(node({ name: 'demo-control-plane', ip: '10.0.0.10', roles: ['control-plane'] }));
  all.push(node({ name: 'demo-worker-1', ip: '10.0.0.11' }));
  all.push(node({ name: 'demo-worker-2', ip: '10.0.0.12' }));

  // ── demo-app namespace ───────────────────────────────────────────────────
  all.push(
    deployment({
      name: 'web',
      namespace: 'demo-app',
      replicas: 3,
      labels: { app: 'web' },
      ageSeconds: 86400,
      template: {
        metadata: { labels: { app: 'web' } },
        spec: {
          containers: [
            {
              name: 'web',
              image: 'nginx:1.27',
              ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
              env: [
                { name: 'NODE_ENV', value: 'production' },
                {
                  name: 'API_URL',
                  valueFrom: { configMapKeyRef: { name: 'web-config', key: 'api_url' } },
                },
                {
                  name: 'SESSION_SECRET',
                  valueFrom: { secretKeyRef: { name: 'web-secrets', key: 'session_secret' } },
                },
                { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              ],
              envFrom: [{ configMapRef: { name: 'web-config' } }],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              volumeMounts: [
                { name: 'config', mountPath: '/etc/nginx/conf.d', readOnly: true },
                { name: 'tls', mountPath: '/etc/tls', readOnly: true },
              ],
              livenessProbe: {
                httpGet: { path: '/healthz', port: 80, scheme: 'HTTP' },
                initialDelaySeconds: 10,
                periodSeconds: 10,
              },
              readinessProbe: {
                httpGet: { path: '/ready', port: 80 },
                initialDelaySeconds: 3,
                periodSeconds: 5,
              },
            },
          ],
          volumes: [
            { name: 'config', configMap: { name: 'web-config' } },
            { name: 'tls', secret: { secretName: 'web-tls' } },
          ],
        },
      },
    }),
  );

  all.push(
    replicaSet({
      name: 'web-7fbd4c8b6c',
      namespace: 'demo-app',
      replicas: 3,
      labels: { app: 'web' },
      ownerDeployment: 'web',
    }),
  );

  for (let i = 0; i < 3; i++) {
    all.push(
      pod({
        name: `web-7fbd4c8b6c-${Math.random().toString(36).slice(2, 7)}`,
        namespace: 'demo-app',
        labels: { app: 'web', 'pod-template-hash': '7fbd4c8b6c' },
        ownerKind: 'ReplicaSet',
        ownerName: 'web-7fbd4c8b6c',
        ageSeconds: 7200 + i * 60,
        nodeName: `demo-worker-${(i % 2) + 1}`,
        containers: [
          {
            name: 'web',
            image: 'nginx:1.27',
            ports: [{ name: 'http', containerPort: 80, protocol: 'TCP' }],
            env: [
              { name: 'NODE_ENV', value: 'production' },
              {
                name: 'API_URL',
                valueFrom: { configMapKeyRef: { name: 'web-config', key: 'api_url' } },
              },
              {
                name: 'SESSION_SECRET',
                valueFrom: { secretKeyRef: { name: 'web-secrets', key: 'session_secret' } },
              },
              { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            ],
            envFrom: [{ configMapRef: { name: 'web-config' } }],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '500m', memory: '256Mi' },
            },
            volumeMounts: [
              { name: 'config', mountPath: '/etc/nginx/conf.d', readOnly: true },
              { name: 'tls', mountPath: '/etc/tls', readOnly: true },
            ],
            livenessProbe: {
              httpGet: { path: '/healthz', port: 80, scheme: 'HTTP' },
              initialDelaySeconds: 10,
              periodSeconds: 10,
            },
            readinessProbe: {
              httpGet: { path: '/ready', port: 80 },
              initialDelaySeconds: 3,
              periodSeconds: 5,
            },
          },
        ],
        volumes: [
          { name: 'config', configMap: { name: 'web-config' } },
          { name: 'tls', secret: { secretName: 'web-tls' } },
        ],
        restartCount: i === 0 ? 2 : 0,
      }),
    );
  }

  all.push(service({
    name: 'web',
    namespace: 'demo-app',
    type: 'ClusterIP',
    ports: [{ name: 'http', port: 80, targetPort: 'http' }],
  }));

  // api deployment
  all.push(
    deployment({
      name: 'api',
      namespace: 'demo-app',
      replicas: 2,
      labels: { app: 'api' },
      ageSeconds: 43200,
      template: {
        metadata: { labels: { app: 'api' } },
        spec: {
          containers: [
            {
              name: 'api',
              image: 'ghcr.io/example/api:v2.4.1',
              ports: [
                { name: 'http', containerPort: 8080 },
                { name: 'metrics', containerPort: 9090 },
              ],
              env: [
                { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'api-secrets', key: 'database_url' } } },
                { name: 'REDIS_URL', value: 'redis://redis:6379' },
                { name: 'LOG_LEVEL', value: 'info' },
              ],
              resources: {
                requests: { cpu: '250m', memory: '256Mi' },
                limits: { cpu: '1', memory: '512Mi' },
              },
            },
          ],
        },
      },
    }),
  );
  all.push(replicaSet({ name: 'api-5d8c7b9f4', namespace: 'demo-app', replicas: 2, labels: { app: 'api' }, ownerDeployment: 'api' }));
  for (let i = 0; i < 2; i++) {
    all.push(pod({
      name: `api-5d8c7b9f4-${Math.random().toString(36).slice(2, 7)}`,
      namespace: 'demo-app',
      labels: { app: 'api', 'pod-template-hash': '5d8c7b9f4' },
      ownerKind: 'ReplicaSet',
      ownerName: 'api-5d8c7b9f4',
      ageSeconds: 4500 + i * 30,
      nodeName: `demo-worker-${(i % 2) + 1}`,
      containers: [{
        name: 'api',
        image: 'ghcr.io/example/api:v2.4.1',
        ports: [
          { name: 'http', containerPort: 8080 },
          { name: 'metrics', containerPort: 9090 },
        ],
        env: [
          { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'api-secrets', key: 'database_url' } } },
          { name: 'REDIS_URL', value: 'redis://redis:6379' },
          { name: 'LOG_LEVEL', value: 'info' },
        ],
        resources: { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } },
      }],
    }));
  }
  all.push(service({
    name: 'api',
    namespace: 'demo-app',
    ports: [{ name: 'http', port: 8080, targetPort: 'http' }, { name: 'metrics', port: 9090 }],
  }));

  // redis - simple single-instance
  all.push(
    deployment({
      name: 'redis',
      namespace: 'demo-app',
      replicas: 1,
      labels: { app: 'redis' },
      ageSeconds: 86400 * 7,
      template: {
        metadata: { labels: { app: 'redis' } },
        spec: {
          containers: [{
            name: 'redis',
            image: 'redis:7-alpine',
            ports: [{ name: 'redis', containerPort: 6379 }],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: { requests: { cpu: '50m', memory: '128Mi' } },
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'redis-data' } }],
        },
      },
    }),
  );
  all.push(replicaSet({ name: 'redis-7c4b5d6f', namespace: 'demo-app', replicas: 1, labels: { app: 'redis' }, ownerDeployment: 'redis' }));
  all.push(pod({
    name: 'redis-7c4b5d6f-x9k2p',
    namespace: 'demo-app',
    labels: { app: 'redis', 'pod-template-hash': '7c4b5d6f' },
    ownerKind: 'ReplicaSet',
    ownerName: 'redis-7c4b5d6f',
    ageSeconds: 86400 * 7,
    containers: [{
      name: 'redis',
      image: 'redis:7-alpine',
      ports: [{ name: 'redis', containerPort: 6379 }],
      volumeMounts: [{ name: 'data', mountPath: '/data' }],
      resources: { requests: { cpu: '50m', memory: '128Mi' } },
    }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'redis-data' } }],
  }));
  all.push(service({ name: 'redis', namespace: 'demo-app', ports: [{ name: 'redis', port: 6379, targetPort: 6379 }] }));

  // PVC for redis
  all.push({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: 'redis-data',
      namespace: 'demo-app',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 7 * 1000),
      labels: { app: 'redis' },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '8Gi' } },
      storageClassName: 'standard',
      volumeMode: 'Filesystem',
    },
    status: { phase: 'Bound', capacity: { storage: '8Gi' }, accessModes: ['ReadWriteOnce'] },
  } as K8sObject);

  // Ingress for web
  all.push({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'web',
      namespace: 'demo-app',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 1000),
      annotations: { 'kubernetes.io/ingress.class': 'nginx' },
    },
    spec: {
      tls: [{ hosts: ['demo.example.com'], secretName: 'web-tls' }],
      rules: [
        {
          host: 'demo.example.com',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'web', port: { name: 'http' } } },
              },
            ],
          },
        },
      ],
    },
    status: { loadBalancer: { ingress: [{ ip: '203.0.113.42' }] } },
  } as K8sObject);

  // ConfigMaps + Secrets
  all.push(configMap('web-config', 'demo-app', {
    api_url: 'http://api:8080',
    feature_flag_dark_mode: 'true',
    feature_flag_new_ui: 'false',
    log_level: 'info',
    'nginx.conf': 'server {\n  listen 80;\n  location / {\n    return 200 "demo";\n  }\n}',
  }));
  all.push(configMap('api-config', 'demo-app', {
    timeout_seconds: '30',
    max_connections: '100',
    cors_origins: 'https://demo.example.com',
  }));

  all.push(secret({
    name: 'web-secrets',
    namespace: 'demo-app',
    data: { session_secret: 'sup3r-s3cr3t-r4nd0m-string-do-not-use', cookie_key: 'another-secret-value' },
  }));
  all.push(secret({
    name: 'api-secrets',
    namespace: 'demo-app',
    data: {
      database_url: 'postgres://user:pass@postgres.demo-app.svc:5432/api',
      jwt_signing_key: 'eyJhbGciOiJIUzI1NiJ9-demo-key-do-not-use-in-prod',
    },
  }));
  all.push(secret({
    name: 'web-tls',
    namespace: 'demo-app',
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': '-----BEGIN CERTIFICATE-----\nMIIDdemoCert...\n-----END CERTIFICATE-----',
      'tls.key': '-----BEGIN PRIVATE KEY-----\nMIIEvdemoKey...\n-----END PRIVATE KEY-----',
    },
  }));
  all.push(secret({
    name: 'regcred',
    namespace: 'demo-app',
    type: 'kubernetes.io/dockerconfigjson',
    data: {
      '.dockerconfigjson': '{"auths":{"ghcr.io":{"username":"demo","password":"demo-token","auth":"ZGVtbzpkZW1vLXRva2Vu"}}}',
    },
  }));

  // ── monitoring namespace ─────────────────────────────────────────────────
  all.push(
    deployment({
      name: 'grafana',
      namespace: 'monitoring',
      replicas: 1,
      labels: { app: 'grafana' },
      ageSeconds: 86400 * 14,
      template: {
        metadata: { labels: { app: 'grafana' } },
        spec: {
          containers: [{
            name: 'grafana',
            image: 'grafana/grafana:11.2.0',
            ports: [{ name: 'http', containerPort: 3000 }],
            env: [
              { name: 'GF_SECURITY_ADMIN_PASSWORD', valueFrom: { secretKeyRef: { name: 'grafana-secrets', key: 'admin_password' } } },
            ],
            volumeMounts: [{ name: 'data', mountPath: '/var/lib/grafana' }],
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'grafana-data' } }],
        },
      },
    }),
  );
  all.push(replicaSet({ name: 'grafana-6f7d8c9b', namespace: 'monitoring', replicas: 1, labels: { app: 'grafana' }, ownerDeployment: 'grafana' }));
  all.push(pod({
    name: 'grafana-6f7d8c9b-h4k7m',
    namespace: 'monitoring',
    labels: { app: 'grafana', 'pod-template-hash': '6f7d8c9b' },
    ownerKind: 'ReplicaSet',
    ownerName: 'grafana-6f7d8c9b',
    ageSeconds: 86400 * 5,
    containers: [{
      name: 'grafana',
      image: 'grafana/grafana:11.2.0',
      ports: [{ name: 'http', containerPort: 3000 }],
      env: [
        { name: 'GF_SECURITY_ADMIN_PASSWORD', valueFrom: { secretKeyRef: { name: 'grafana-secrets', key: 'admin_password' } } },
      ],
      volumeMounts: [{ name: 'data', mountPath: '/var/lib/grafana' }],
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
    }],
    volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'grafana-data' } }],
  }));
  all.push(service({ name: 'grafana', namespace: 'monitoring', ports: [{ name: 'http', port: 3000, targetPort: 'http' }] }));
  all.push(secret({
    name: 'grafana-secrets',
    namespace: 'monitoring',
    data: { admin_password: 'admin-demo-2026', smtp_password: 'smtp-demo' },
  }));

  // ── kube-system: coredns + a DaemonSet ───────────────────────────────────
  all.push(
    deployment({
      name: 'coredns',
      namespace: 'kube-system',
      replicas: 2,
      labels: { 'k8s-app': 'kube-dns' },
      ageSeconds: 86400 * 30,
      template: {
        metadata: { labels: { 'k8s-app': 'kube-dns' } },
        spec: {
          containers: [{
            name: 'coredns',
            image: 'registry.k8s.io/coredns/coredns:v1.11.3',
            ports: [
              { name: 'dns', containerPort: 53, protocol: 'UDP' },
              { name: 'dns-tcp', containerPort: 53, protocol: 'TCP' },
              { name: 'metrics', containerPort: 9153 },
            ],
            resources: { requests: { cpu: '100m', memory: '70Mi' } },
          }],
        },
      },
    }),
  );
  all.push(replicaSet({ name: 'coredns-558bd4d5d', namespace: 'kube-system', replicas: 2, labels: { 'k8s-app': 'kube-dns' }, ownerDeployment: 'coredns' }));
  for (let i = 0; i < 2; i++) {
    all.push(pod({
      name: `coredns-558bd4d5d-${Math.random().toString(36).slice(2, 7)}`,
      namespace: 'kube-system',
      labels: { 'k8s-app': 'kube-dns', 'pod-template-hash': '558bd4d5d' },
      ownerKind: 'ReplicaSet',
      ownerName: 'coredns-558bd4d5d',
      ageSeconds: 86400 * 14,
      nodeName: i === 0 ? 'demo-control-plane' : 'demo-worker-1',
      containers: [{
        name: 'coredns',
        image: 'registry.k8s.io/coredns/coredns:v1.11.3',
        ports: [
          { name: 'dns', containerPort: 53, protocol: 'UDP' },
          { name: 'dns-tcp', containerPort: 53, protocol: 'TCP' },
          { name: 'metrics', containerPort: 9153 },
        ],
        resources: { requests: { cpu: '100m', memory: '70Mi' } },
      }],
    }));
  }

  // DaemonSet: kube-proxy
  all.push({
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: {
      name: 'kube-proxy',
      namespace: 'kube-system',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 30 * 1000),
      labels: { 'k8s-app': 'kube-proxy' },
    },
    spec: {
      selector: { matchLabels: { 'k8s-app': 'kube-proxy' } },
      template: {
        metadata: { labels: { 'k8s-app': 'kube-proxy' } },
        spec: {
          containers: [{
            name: 'kube-proxy',
            image: 'registry.k8s.io/kube-proxy:v1.32.0',
            command: ['/usr/local/bin/kube-proxy'],
            args: ['--config=/var/lib/kube-proxy/config.conf'],
          }],
          hostNetwork: true,
          tolerations: [{ operator: 'Exists' }],
        },
      },
    },
    status: {
      currentNumberScheduled: 3,
      numberMisscheduled: 0,
      desiredNumberScheduled: 3,
      numberReady: 3,
      updatedNumberScheduled: 3,
      numberAvailable: 3,
      observedGeneration: 1,
    },
  } as K8sObject);

  // StatefulSet: prometheus
  all.push({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: 'prometheus',
      namespace: 'monitoring',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 14 * 1000),
      labels: { app: 'prometheus' },
    },
    spec: {
      serviceName: 'prometheus',
      replicas: 1,
      selector: { matchLabels: { app: 'prometheus' } },
      template: {
        metadata: { labels: { app: 'prometheus' } },
        spec: {
          containers: [{
            name: 'prometheus',
            image: 'prom/prometheus:v2.54.0',
            ports: [{ name: 'http', containerPort: 9090 }],
            resources: { requests: { cpu: '200m', memory: '512Mi' }, limits: { cpu: '1', memory: '2Gi' } },
          }],
        },
      },
    },
    status: { replicas: 1, readyReplicas: 1, currentReplicas: 1, observedGeneration: 1 },
  } as K8sObject);

  // ── Helm releases ────────────────────────────────────────────────────────
  // Stored as helm.sh/release.v1 Secrets — the exact wire format the Helm
  // CLI uses. The list / detail screens decode them via the same
  // src/lib/k8s/helm.ts pipeline real clusters go through, so the demo can't
  // accidentally accept a payload shape that wouldn't decode in production.

  pushHelmRelease(all, {
    name: 'warp',
    namespace: 'demo-app',
    version: 2,
    status: 'deployed',
    chartName: 'warp',
    chartVersion: '0.5.2',
    appVersion: '1.2.0',
    description: 'Modern Kubernetes-native web app platform',
    icon: 'https://avatars.githubusercontent.com/u/0?s=200',
    home: 'https://github.com/example/warp',
    keywords: ['web', 'platform', 'demo'],
    defaultValues: {
      replicaCount: 1,
      image: { repository: 'ghcr.io/example/warp', tag: 'latest', pullPolicy: 'IfNotPresent' },
      service: { type: 'ClusterIP', port: 80 },
      ingress: { enabled: false, className: 'nginx', host: 'demo.example.com' },
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
    },
    config: {
      replicaCount: 3,
      image: { tag: '1.2.0' },
      ingress: { enabled: true, host: 'demo.example.com', tls: true },
    },
    manifest:
      '---\n# Source: warp/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: warp-warp-frontend\n  namespace: demo-app\n  labels:\n    app.kubernetes.io/name: warp\n    app.kubernetes.io/instance: warp\n    app.kubernetes.io/version: "1.2.0"\nspec:\n  replicas: 3\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: warp\n  template:\n    spec:\n      containers:\n        - name: warp\n          image: "ghcr.io/example/warp:1.2.0"\n          ports:\n            - containerPort: 3000\n---\n# Source: warp/templates/service.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: warp\n  namespace: demo-app\nspec:\n  type: ClusterIP\n  ports:\n    - port: 80\n      targetPort: 3000\n  selector:\n    app.kubernetes.io/name: warp\n',
    notes:
      "1. Get the application URL by running these commands:\n  https://demo.example.com/\n\n2. Watch the deployment roll out:\n  kubectl get pods -n demo-app -l app.kubernetes.io/instance=warp -w\n\nFor more information, see https://github.com/example/warp\n",
    firstDeployed: ago(86400 * 1000 * 14),
    lastDeployed: ago(86400 * 1000),
  });

  // Superseded revision of warp — gives the History view something to show.
  pushHelmRelease(all, {
    name: 'warp',
    namespace: 'demo-app',
    version: 1,
    status: 'superseded',
    chartName: 'warp',
    chartVersion: '0.5.1',
    appVersion: '1.1.5',
    description: 'Modern Kubernetes-native web app platform',
    defaultValues: { replicaCount: 1, image: { tag: 'latest' } },
    config: { replicaCount: 2, image: { tag: '1.1.5' } },
    manifest: '---\n# (truncated — see latest revision for full manifest)\n',
    notes: 'Initial install.',
    firstDeployed: ago(86400 * 1000 * 14),
    lastDeployed: ago(86400 * 1000 * 14),
  });

  pushHelmRelease(all, {
    name: 'redis',
    namespace: 'demo-app',
    version: 1,
    status: 'deployed',
    chartName: 'redis',
    chartVersion: '19.5.2',
    appVersion: '7.4.0',
    description: 'Redis(R) is an open source, advanced key-value store.',
    home: 'https://github.com/bitnami/charts/tree/main/bitnami/redis',
    keywords: ['redis', 'keyvalue', 'database'],
    defaultValues: {
      architecture: 'standalone',
      auth: { enabled: false },
      master: { persistence: { enabled: true, size: '8Gi' } },
    },
    config: {
      architecture: 'standalone',
      master: { persistence: { size: '8Gi' } },
    },
    manifest:
      '---\n# Source: redis/templates/master/statefulset.yaml\napiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: redis-master\n  namespace: demo-app\nspec:\n  serviceName: redis-master\n  replicas: 1\n',
    firstDeployed: ago(86400 * 1000 * 7),
    lastDeployed: ago(86400 * 1000 * 7),
  });

  pushHelmRelease(all, {
    name: 'kube-prometheus-stack',
    namespace: 'monitoring',
    version: 3,
    status: 'deployed',
    chartName: 'kube-prometheus-stack',
    chartVersion: '63.1.0',
    appVersion: 'v0.76.1',
    description: 'kube-prometheus-stack collects Kubernetes manifests, dashboards, and Prometheus rules with documentation and scripts to provide easy to operate end-to-end Kubernetes cluster monitoring with Prometheus using the Prometheus Operator.',
    home: 'https://github.com/prometheus-operator/kube-prometheus',
    keywords: ['operator', 'prometheus', 'kube-prometheus', 'monitoring'],
    defaultValues: {
      grafana: { enabled: true, defaultDashboardsEnabled: true },
      prometheus: { enabled: true, prometheusSpec: { retention: '10d' } },
      alertmanager: { enabled: true },
    },
    config: {
      grafana: {
        enabled: true,
        adminPassword: 'admin-demo-2026',
        ingress: { enabled: true, hosts: ['grafana.demo.example.com'] },
      },
      prometheus: {
        prometheusSpec: { retention: '30d', resources: { requests: { memory: '512Mi', cpu: '200m' } } },
      },
    },
    manifest:
      '---\n# Source: kube-prometheus-stack/charts/grafana/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: kube-prometheus-stack-grafana\n  namespace: monitoring\nspec:\n  replicas: 1\n',
    firstDeployed: ago(86400 * 1000 * 30),
    lastDeployed: ago(3600 * 1000 * 4),
  });

  // A failed release — gives the list view a non-green status badge.
  pushHelmRelease(all, {
    name: 'experimental-cache',
    namespace: 'demo-app',
    version: 1,
    status: 'failed',
    chartName: 'memcached',
    chartVersion: '7.4.5',
    appVersion: '1.6.30',
    description: 'A high-performance, distributed memory object caching system.',
    defaultValues: { replicaCount: 3 },
    config: { replicaCount: 3, persistence: { enabled: true, size: '100Gi' } },
    manifest: '---\n# (manifest omitted — release failed during install)\n',
    notes: 'Install failed. Run "helm uninstall experimental-cache" to clean up.',
    firstDeployed: ago(3600 * 1000 * 2),
    lastDeployed: ago(3600 * 1000 * 2),
    description2: 'failed to install: timed out waiting for the condition',
  });

  // ── CRDs: cert-manager + ArgoCD ──────────────────────────────────────────
  // These exist purely to demonstrate that the app handles non-builtin
  // resources properly. The cert-manager operator pod isn't included —
  // these are just the API objects the controller would manage.

  // ClusterIssuer: a cluster-scoped self-signed CA.
  all.push({
    apiVersion: 'cert-manager.io/v1',
    kind: 'ClusterIssuer',
    metadata: {
      name: 'selfsigned-cluster',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(30 * 86400 * 1000),
    },
    spec: { selfSigned: {} },
    status: {
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'IsReady',
          message: 'Self-signed issuer is ready',
          lastTransitionTime: ago(30 * 86400 * 1000),
        },
      ],
    },
  } as unknown as K8sObject);

  // Issuer: ACME (Let's Encrypt) for demo-app.
  all.push({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Issuer',
    metadata: {
      name: 'letsencrypt-prod',
      namespace: 'demo-app',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(14 * 86400 * 1000),
    },
    spec: {
      acme: {
        email: 'demo@example.com',
        server: 'https://acme-v02.api.letsencrypt.org/directory',
        privateKeySecretRef: { name: 'letsencrypt-prod-key' },
        solvers: [
          { http01: { ingress: { class: 'nginx' } } },
        ],
      },
    },
    status: {
      acme: {
        uri: 'https://acme-v02.api.letsencrypt.org/acme/acct/123456789',
        lastRegisteredEmail: 'demo@example.com',
      },
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'ACMEAccountRegistered',
          message: 'The ACME account was registered with the ACME server',
          lastTransitionTime: ago(14 * 86400 * 1000),
        },
      ],
    },
  } as unknown as K8sObject);

  // Certificate: the TLS cert that backs the web Ingress. Owns the
  // web-tls Secret via ownerReferences so the user can navigate up the
  // chain from the Secret to the Certificate.
  all.push({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: 'web-tls-cert',
      namespace: 'demo-app',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(7 * 86400 * 1000),
      labels: { app: 'web' },
    },
    spec: {
      secretName: 'web-tls',
      issuerRef: { name: 'letsencrypt-prod', kind: 'Issuer', group: 'cert-manager.io' },
      commonName: 'demo.example.com',
      dnsNames: ['demo.example.com', 'www.demo.example.com'],
      duration: '2160h',
      renewBefore: '720h',
      privateKey: { algorithm: 'RSA', size: 2048 },
      usages: ['digital signature', 'key encipherment'],
    },
    status: {
      notBefore: ago(7 * 86400 * 1000),
      notAfter: ago(-83 * 86400 * 1000), // 83 days in the future
      renewalTime: ago(-53 * 86400 * 1000),
      revision: 1,
      conditions: [
        {
          type: 'Ready',
          status: 'True',
          reason: 'Ready',
          message: 'Certificate is up to date and has not expired',
          lastTransitionTime: ago(7 * 86400 * 1000),
        },
      ],
    },
  } as unknown as K8sObject);

  // A second Certificate that's currently being issued — gives the user
  // an example of a non-Ready CR in the list view.
  all.push({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: {
      name: 'grafana-tls-cert',
      namespace: 'monitoring',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(5 * 60 * 1000),
      labels: { app: 'grafana' },
    },
    spec: {
      secretName: 'grafana-tls',
      issuerRef: { name: 'selfsigned-cluster', kind: 'ClusterIssuer', group: 'cert-manager.io' },
      commonName: 'grafana.demo.example.com',
      dnsNames: ['grafana.demo.example.com'],
    },
    status: {
      conditions: [
        {
          type: 'Ready',
          status: 'False',
          reason: 'Issuing',
          message: 'Issuing certificate as Secret does not exist',
          lastTransitionTime: ago(3 * 60 * 1000),
        },
        {
          type: 'Issuing',
          status: 'True',
          reason: 'Issuing',
          message: 'The certificate is being issued',
          lastTransitionTime: ago(3 * 60 * 1000),
        },
      ],
    },
  } as unknown as K8sObject);

  // CertificateRequest tied to the in-progress grafana cert — exercises
  // owner references to a CRD owner.
  all.push({
    apiVersion: 'cert-manager.io/v1',
    kind: 'CertificateRequest',
    metadata: {
      name: 'grafana-tls-cert-1',
      namespace: 'monitoring',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(3 * 60 * 1000),
      labels: { app: 'grafana' },
      ownerReferences: [
        {
          apiVersion: 'cert-manager.io/v1',
          kind: 'Certificate',
          name: 'grafana-tls-cert',
          uid: uid(),
          controller: true,
          blockOwnerDeletion: true,
        },
      ],
    },
    spec: {
      issuerRef: { name: 'selfsigned-cluster', kind: 'ClusterIssuer', group: 'cert-manager.io' },
      request: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURSBSRVFVRVNULS0tLS0KZGVtbyBkYXRh\n-----END CERTIFICATE REQUEST-----',
      usages: ['digital signature', 'key encipherment'],
    },
    status: {
      conditions: [
        {
          type: 'Approved',
          status: 'True',
          reason: 'cert-manager.io',
          message: 'Certificate request has been approved by cert-manager.io',
          lastTransitionTime: ago(2 * 60 * 1000),
        },
        {
          type: 'Ready',
          status: 'False',
          reason: 'Pending',
          message: 'Waiting on issuer to issue certificate',
          lastTransitionTime: ago(2 * 60 * 1000),
        },
      ],
    },
  } as unknown as K8sObject);

  // ArgoCD Application — a GitOps Application object pointing at the
  // demo-app namespace. Lots of teams use ArgoCD so it's a recognisable
  // second CRD to round out the demo.
  all.push({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: {
      name: 'demo-app',
      namespace: 'argocd',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(30 * 86400 * 1000),
      labels: { 'app.kubernetes.io/instance': 'demo-app' },
      finalizers: ['resources-finalizer.argocd.argoproj.io'],
    },
    spec: {
      project: 'default',
      source: {
        repoURL: 'https://github.com/example/demo-app',
        path: 'manifests',
        targetRevision: 'main',
      },
      destination: {
        server: 'https://kubernetes.default.svc',
        namespace: 'demo-app',
      },
      syncPolicy: {
        automated: { prune: true, selfHeal: true },
        syncOptions: ['CreateNamespace=true'],
      },
    },
    status: {
      sync: { status: 'Synced', revision: 'abc1234' },
      health: { status: 'Healthy' },
      operationState: {
        phase: 'Succeeded',
        message: 'successfully synced',
        startedAt: ago(2 * 3600 * 1000),
        finishedAt: ago(2 * 3600 * 1000 - 30_000),
      },
      reconciledAt: ago(60 * 1000),
    },
  } as unknown as K8sObject);

  // CronJob
  all.push({
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: {
      name: 'backup',
      namespace: 'demo-app',
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: ago(86400 * 3 * 1000),
    },
    spec: {
      schedule: '0 2 * * *',
      concurrencyPolicy: 'Forbid',
      jobTemplate: {
        spec: {
          template: {
            spec: {
              containers: [{
                name: 'backup',
                image: 'demo/backup:latest',
                command: ['/scripts/backup.sh'],
              }],
              restartPolicy: 'OnFailure',
            },
          },
        },
      },
    },
    status: {
      lastScheduleTime: ago(3600 * 1000 * 6),
      lastSuccessfulTime: ago(3600 * 1000 * 6 - 60_000),
    },
  } as K8sObject);

  return all;
}

// ── Helm release fixture helper ────────────────────────────────────────────

type HelmReleaseFixture = {
  name: string;
  namespace: string;
  version: number;
  status: string;
  chartName: string;
  chartVersion: string;
  appVersion?: string;
  description?: string;
  icon?: string;
  home?: string;
  keywords?: string[];
  defaultValues: Record<string, any>;
  config: Record<string, any>;
  manifest: string;
  notes?: string;
  firstDeployed?: string;
  lastDeployed?: string;
  /** Optional override for release.info.description (defaults to status-y blurb). */
  description2?: string;
};

function pushHelmRelease(all: K8sObject[], opts: HelmReleaseFixture) {
  const raw: HelmReleaseRaw = {
    name: opts.name,
    namespace: opts.namespace,
    version: opts.version,
    info: {
      status: opts.status,
      first_deployed: opts.firstDeployed,
      last_deployed: opts.lastDeployed,
      description: opts.description2
        ?? (opts.status === 'deployed' ? 'Install complete' : `Release ${opts.status}`),
      notes: opts.notes,
    },
    chart: {
      metadata: {
        name: opts.chartName,
        version: opts.chartVersion,
        appVersion: opts.appVersion,
        description: opts.description,
        icon: opts.icon,
        home: opts.home,
        keywords: opts.keywords,
      },
      values: opts.defaultValues,
    },
    config: opts.config,
    manifest: opts.manifest,
  };

  // encodeHelmRelease returns the inner base64 string. Wrap once more with
  // btoa because the demo Secret data path doesn't go through a real K8s
  // API server — it just stores `data` as-is on the in-memory object.
  const inner = encodeHelmRelease(raw);
  all.push({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `sh.helm.release.v1.${opts.name}.v${opts.version}`,
      namespace: opts.namespace,
      uid: uid(),
      resourceVersion: String(Math.floor(Math.random() * 100000)),
      creationTimestamp: opts.lastDeployed ?? ago(86400 * 1000),
      labels: {
        owner: 'helm',
        name: opts.name,
        version: String(opts.version),
        status: opts.status,
      },
    },
    type: 'helm.sh/release.v1',
    data: { release: globalThis.btoa(inner) },
  } as unknown as K8sObject);
}
