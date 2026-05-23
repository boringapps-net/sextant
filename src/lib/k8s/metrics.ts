// metrics.k8s.io/v1beta1 — provided by metrics-server in most clusters.
// CPU is reported as a quantity ("250m" = 0.25 cores).
// Memory is bytes ("1048576Ki" = 1 GiB).

export type NodeMetrics = {
  metadata: { name: string; creationTimestamp?: string };
  timestamp?: string;
  window?: string;
  usage: { cpu?: string; memory?: string };
};

export type PodContainerMetrics = {
  name: string;
  usage: { cpu?: string; memory?: string };
};

export type PodMetrics = {
  metadata: { name: string; namespace?: string; creationTimestamp?: string };
  timestamp?: string;
  window?: string;
  containers: PodContainerMetrics[];
};

export type MetricsList<T> = {
  kind: string;
  apiVersion: string;
  items: T[];
};
