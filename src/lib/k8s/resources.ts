// Registry of built-in resource types. CRDs are merged in at runtime.

export type ResourceCategory =
  | 'Workloads'
  | 'Networking'
  | 'Config'
  | 'Storage'
  | 'Access'
  | 'Cluster'
  | 'Custom';

export type ResourceDef = {
  // URL slug used in routes — kebab-case, plural
  slug: string;
  kind: string;
  apiGroup: string; // '' for core (v1)
  apiVersion: string;
  // Plural name as used in REST paths (pods, deployments, etc.)
  plural: string;
  namespaced: boolean;
  category: ResourceCategory;
  // SF symbol + material symbol for the drawer
  icon: { ios: string; android: string };
  // Optional: hide in drawer (still routable)
  hidden?: boolean;
};

export const BUILTIN_RESOURCES: ResourceDef[] = [
  // Workloads
  {
    slug: 'pods',
    kind: 'Pod',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'pods',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'cube.box', android: 'deployed_code' },
  },
  {
    slug: 'deployments',
    kind: 'Deployment',
    apiGroup: 'apps',
    apiVersion: 'v1',
    plural: 'deployments',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'square.stack.3d.up', android: 'inventory_2' },
  },
  {
    slug: 'statefulsets',
    kind: 'StatefulSet',
    apiGroup: 'apps',
    apiVersion: 'v1',
    plural: 'statefulsets',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'cylinder.split.1x2', android: 'storage' },
  },
  {
    slug: 'daemonsets',
    kind: 'DaemonSet',
    apiGroup: 'apps',
    apiVersion: 'v1',
    plural: 'daemonsets',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'square.grid.2x2', android: 'apps' },
  },
  {
    slug: 'replicasets',
    kind: 'ReplicaSet',
    apiGroup: 'apps',
    apiVersion: 'v1',
    plural: 'replicasets',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'square.stack', android: 'layers' },
  },
  {
    slug: 'jobs',
    kind: 'Job',
    apiGroup: 'batch',
    apiVersion: 'v1',
    plural: 'jobs',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'hammer', android: 'work' },
  },
  {
    slug: 'cronjobs',
    kind: 'CronJob',
    apiGroup: 'batch',
    apiVersion: 'v1',
    plural: 'cronjobs',
    namespaced: true,
    category: 'Workloads',
    icon: { ios: 'clock.arrow.circlepath', android: 'schedule' },
  },

  // Networking
  {
    slug: 'services',
    kind: 'Service',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'services',
    namespaced: true,
    category: 'Networking',
    icon: { ios: 'point.3.filled.connected.trianglepath.dotted', android: 'hub' },
  },
  {
    slug: 'ingresses',
    kind: 'Ingress',
    apiGroup: 'networking.k8s.io',
    apiVersion: 'v1',
    plural: 'ingresses',
    namespaced: true,
    category: 'Networking',
    icon: { ios: 'arrow.triangle.branch', android: 'alt_route' },
  },
  {
    slug: 'endpoints',
    kind: 'Endpoints',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'endpoints',
    namespaced: true,
    category: 'Networking',
    icon: { ios: 'antenna.radiowaves.left.and.right', android: 'router' },
  },
  {
    slug: 'networkpolicies',
    kind: 'NetworkPolicy',
    apiGroup: 'networking.k8s.io',
    apiVersion: 'v1',
    plural: 'networkpolicies',
    namespaced: true,
    category: 'Networking',
    icon: { ios: 'shield.lefthalf.filled', android: 'policy' },
  },

  // Config
  {
    slug: 'configmaps',
    kind: 'ConfigMap',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'configmaps',
    namespaced: true,
    category: 'Config',
    icon: { ios: 'doc.text', android: 'description' },
  },
  {
    slug: 'secrets',
    kind: 'Secret',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'secrets',
    namespaced: true,
    category: 'Config',
    icon: { ios: 'lock.shield', android: 'lock' },
  },

  // Storage
  {
    slug: 'persistentvolumeclaims',
    kind: 'PersistentVolumeClaim',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'persistentvolumeclaims',
    namespaced: true,
    category: 'Storage',
    icon: { ios: 'externaldrive', android: 'database' },
  },
  {
    slug: 'persistentvolumes',
    kind: 'PersistentVolume',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'persistentvolumes',
    namespaced: false,
    category: 'Storage',
    icon: { ios: 'externaldrive.fill', android: 'storage' },
  },
  {
    slug: 'storageclasses',
    kind: 'StorageClass',
    apiGroup: 'storage.k8s.io',
    apiVersion: 'v1',
    plural: 'storageclasses',
    namespaced: false,
    category: 'Storage',
    icon: { ios: 'square.stack.3d.down.right', android: 'category' },
  },

  // Access
  {
    slug: 'serviceaccounts',
    kind: 'ServiceAccount',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'serviceaccounts',
    namespaced: true,
    category: 'Access',
    icon: { ios: 'person.crop.circle', android: 'account_circle' },
  },
  {
    slug: 'roles',
    kind: 'Role',
    apiGroup: 'rbac.authorization.k8s.io',
    apiVersion: 'v1',
    plural: 'roles',
    namespaced: true,
    category: 'Access',
    icon: { ios: 'person.badge.key', android: 'admin_panel_settings' },
  },
  {
    slug: 'rolebindings',
    kind: 'RoleBinding',
    apiGroup: 'rbac.authorization.k8s.io',
    apiVersion: 'v1',
    plural: 'rolebindings',
    namespaced: true,
    category: 'Access',
    icon: { ios: 'link.circle', android: 'link' },
  },
  {
    slug: 'clusterroles',
    kind: 'ClusterRole',
    apiGroup: 'rbac.authorization.k8s.io',
    apiVersion: 'v1',
    plural: 'clusterroles',
    namespaced: false,
    category: 'Access',
    icon: { ios: 'person.badge.shield.checkmark', android: 'verified_user' },
  },
  {
    slug: 'clusterrolebindings',
    kind: 'ClusterRoleBinding',
    apiGroup: 'rbac.authorization.k8s.io',
    apiVersion: 'v1',
    plural: 'clusterrolebindings',
    namespaced: false,
    category: 'Access',
    icon: { ios: 'link.badge.plus', android: 'group_add' },
  },

  // Cluster
  {
    slug: 'nodes',
    kind: 'Node',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'nodes',
    namespaced: false,
    category: 'Cluster',
    icon: { ios: 'server.rack', android: 'dns' },
  },
  {
    slug: 'namespaces',
    kind: 'Namespace',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'namespaces',
    namespaced: false,
    category: 'Cluster',
    icon: { ios: 'folder', android: 'folder' },
  },
  {
    slug: 'events',
    kind: 'Event',
    apiGroup: '',
    apiVersion: 'v1',
    plural: 'events',
    namespaced: true,
    category: 'Cluster',
    icon: { ios: 'bell.badge', android: 'notifications' },
  },
];

export const RESOURCE_CATEGORIES: ResourceCategory[] = [
  'Workloads',
  'Networking',
  'Config',
  'Storage',
  'Access',
  'Cluster',
  'Custom',
];

export function findBuiltinBySlug(slug: string): ResourceDef | undefined {
  return BUILTIN_RESOURCES.find((r) => r.slug === slug);
}

// Slug encoding for arbitrary CRDs: <plural>.<group> -> "<plural>.<group>"
// We keep the dot — expo-router supports dots in segment values.
export function crdSlug(plural: string, apiGroup: string): string {
  return apiGroup ? `${plural}.${apiGroup}` : plural;
}

export function parseSlug(slug: string): { plural: string; apiGroup: string } {
  const dot = slug.indexOf('.');
  if (dot === -1) return { plural: slug, apiGroup: '' };
  return { plural: slug.slice(0, dot), apiGroup: slug.slice(dot + 1) };
}

// Look up a built-in or CRD resource def by Kind + apiGroup. apiGroup is the
// group prefix of an apiVersion ("apps/v1" → "apps", "v1" → "" for core).
// Owner references and other refs carry kind+apiVersion, so this lets us turn
// them into a navigable ResourceDef without baking a static kind-to-slug map.
export function findResourceByKindGroup(
  kind: string,
  apiGroup: string,
  crds: ResourceDef[],
): ResourceDef | undefined {
  const builtin = BUILTIN_RESOURCES.find(
    (r) => r.kind === kind && r.apiGroup === apiGroup,
  );
  if (builtin) return builtin;
  return crds.find((r) => r.kind === kind && r.apiGroup === apiGroup);
}

// "apps/v1" → "apps", "v1" → "", "acme.example.com/v1beta1" → "acme.example.com"
export function apiGroupFromVersion(apiVersion: string): string {
  const slash = apiVersion.indexOf('/');
  return slash === -1 ? '' : apiVersion.slice(0, slash);
}
