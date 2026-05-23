// Minimal Kubernetes API types — covers the fields we read in lists/details.
// We deliberately type as Partial / index-friendly because clusters can vary.

export type K8sObjectMeta = {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
  }>;
};

export type K8sObject<Spec = unknown, Status = unknown> = {
  apiVersion: string;
  kind: string;
  metadata: K8sObjectMeta;
  spec?: Spec;
  status?: Status;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  type?: string;
  [key: string]: unknown;
};

export type K8sList<T = K8sObject> = {
  apiVersion: string;
  kind: string;
  metadata: { resourceVersion?: string; continue?: string };
  items: T[];
};

export type APIResource = {
  name: string;
  singularName: string;
  namespaced: boolean;
  kind: string;
  verbs: string[];
  shortNames?: string[];
  categories?: string[];
};

export type APIResourceList = {
  groupVersion: string;
  resources: APIResource[];
};

export type APIGroup = {
  name: string;
  versions: Array<{ groupVersion: string; version: string }>;
  preferredVersion: { groupVersion: string; version: string };
};

export type APIGroupList = {
  groups: APIGroup[];
};

// Common spec/status shapes we touch
export type PodSpec = {
  containers: Array<{ name: string; image: string }>;
  initContainers?: Array<{ name: string; image: string }>;
  nodeName?: string;
};

export type PodStatus = {
  phase?: 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown';
  podIP?: string;
  hostIP?: string;
  startTime?: string;
  containerStatuses?: Array<{
    name: string;
    ready: boolean;
    restartCount: number;
    state?: {
      running?: { startedAt: string };
      waiting?: { reason: string; message?: string };
      terminated?: { reason: string; exitCode: number };
    };
  }>;
  conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
};

export type Pod = K8sObject<PodSpec, PodStatus>;

export type DeploymentSpec = {
  replicas?: number;
  selector?: { matchLabels?: Record<string, string> };
  strategy?: { type?: string };
};

export type DeploymentStatus = {
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  unavailableReplicas?: number;
  conditions?: Array<{ type: string; status: string; reason?: string }>;
};

export type Deployment = K8sObject<DeploymentSpec, DeploymentStatus>;
