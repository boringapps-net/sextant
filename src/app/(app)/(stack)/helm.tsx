import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';
import { ResourceTable } from '@/components/ResourceTable';
import { useClusters } from '@/lib/state/cluster-context';
import { listHelmReleases, type HelmRelease } from '@/lib/k8s/helm';
import type { Column } from '@/lib/k8s/row-columns';
import type { RowSummary } from '@/lib/k8s/row-summaries';
import { age } from '@/lib/util/time';

// ── Column definitions for the table (iPad / wide) view ────────────────────
// Mirrors the kubectl-ish "helm list" columns. Priority orders the drop
// sequence as available width shrinks: name/status are essential; chart-
// version is dropped first, then app-version, then revision.
const HELM_COLUMNS: Column<HelmRelease>[] = [
  { key: 'name', label: 'Name', render: (r) => r.name, weight: 2, minWidth: 140, priority: 1 },
  { key: 'namespace', label: 'Namespace', render: (r) => r.namespace, weight: 1, minWidth: 100, priority: 2 },
  {
    key: 'chart',
    label: 'Chart',
    render: (r) => `${r.chart.name}-${r.chart.version}`,
    mono: true,
    weight: 2,
    minWidth: 150,
    priority: 3,
  },
  {
    key: 'app',
    label: 'App version',
    render: (r) => r.chart.appVersion ?? '—',
    mono: true,
    weight: 1,
    minWidth: 90,
    priority: 4,
  },
  {
    key: 'rev',
    label: 'Rev',
    render: (r) => String(r.version),
    weight: 0.5,
    minWidth: 50,
    align: 'right',
    priority: 5,
  },
  { key: 'status', label: 'Status', render: (r) => r.status, weight: 1, minWidth: 90, priority: 2 },
  {
    key: 'age',
    label: 'Age',
    render: (r) => (r.lastDeployed ? age(r.lastDeployed) : '—'),
    weight: 0.7,
    minWidth: 60,
    align: 'right',
    priority: 3,
  },
];

// Helm release status → the same status colour palette the resource list uses
// (ok/warn/bad/info/muted). Lets the shared ResourceTable / dot indicator do
// the rendering without needing to know about Helm-specific states.
function helmStatusKind(r: HelmRelease): RowSummary['status'] {
  switch (r.status) {
    case 'deployed':
      return 'ok';
    case 'failed':
    case 'pending-rollback':
      return 'bad';
    case 'uninstalled':
    case 'uninstalling':
    case 'superseded':
      return 'muted';
    case 'pending-install':
    case 'pending-upgrade':
      return 'warn';
    default:
      return 'info';
  }
}

export default function HelmReleasesScreen() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  const { client, activeNamespace } = useClusters();
  const dims = useWindowDimensions();

  // Same responsive logic R-list uses: tablet at short edge ≥ 600, then a
  // table-vs-list flip at viewport ≥ 700 (accounting for the 320pt drawer).
  const isIPad =
    Platform.OS === 'ios' &&
    ((Platform as any).isPad === true || Math.min(dims.width, dims.height) >= 768);
  const drawerWidth = isIPad || Math.min(dims.width, dims.height) >= 600 ? 320 : 0;
  const tableViewport = dims.width - drawerWidth;
  const useTable = tableViewport >= 700;

  const [filter, setFilter] = useState('');
  const [releases, setReleases] = useState<HelmRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const r = await listHelmReleases(client, activeNamespace);
      setReleases(r);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [client, activeNamespace]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return releases;
    const q = filter.toLowerCase();
    return releases.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.namespace.toLowerCase().includes(q) ||
        r.chart.name.toLowerCase().includes(q),
    );
  }, [releases, filter]);

  const onPressRow = useCallback(
    (r: HelmRelease) => {
      router.push(
        `/(app)/(stack)/helm-release/${encodeURIComponent(r.name)}?namespace=${encodeURIComponent(r.namespace)}` as any,
      );
    },
    [router],
  );

  const searchHeader = (
    <View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: c.surfaceMuted,
          borderRadius: Radii.md,
          paddingHorizontal: 10,
          height: 38,
          gap: 6,
        }}
      >
        <Icon ios="magnifyingglass" android="search" size={15} color={c.textSecondary} />
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter releases"
          placeholderTextColor={c.textTertiary}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, color: c.text, fontSize: 15 }}
        />
      </View>
      {error ? (
        <Glass radius={Radii.md} style={{ padding: Spacing.md, marginTop: Spacing.sm }}>
          <Text style={{ color: c.danger, ...Typography.subhead }}>{error}</Text>
        </Glass>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: 'Helm releases',
          headerLeft: () => <DrawerToggle />,
        }}
      />

      {loading && releases.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : useTable ? (
        <ResourceTable<HelmRelease>
          items={filtered}
          columns={HELM_COLUMNS}
          width={tableViewport}
          getKey={(r) => `${r.namespace}/${r.name}`}
          getStatus={helmStatusKind}
          refreshing={loading}
          onRefresh={load}
          onPressRow={onPressRow}
          emptyIcon={{ ios: 'shippingbox', android: 'inventory_2' }}
          emptyLabel={`No Helm releases ${activeNamespace ? `in ${activeNamespace}` : ''}`}
          listHeader={
            <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
              {searchHeader}
            </View>
          }
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(r) => `${r.namespace}/${r.name}`}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: Spacing.lg, paddingBottom: 60 }}
          stickyHeaderIndices={[0]}
          ListHeaderComponent={
            <View
              style={{
                backgroundColor: c.background,
                paddingBottom: Spacing.sm,
                paddingTop: Spacing.xs,
              }}
            >
              {searchHeader}
            </View>
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 0.5, backgroundColor: c.separator, marginLeft: 14 }} />
          )}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={load} tintColor={c.text} />
          }
          renderItem={({ item }) => (
            <ReleaseRow release={item} onPress={() => onPressRow(item)} />
          )}
          ListEmptyComponent={() => (
            <View style={{ paddingVertical: 40, alignItems: 'center', gap: 8 }}>
              <Icon ios="shippingbox" android="inventory_2" size={28} color={c.textTertiary} />
              <Text style={{ color: c.textSecondary, ...Typography.subhead }}>
                No Helm releases {activeNamespace ? `in ${activeNamespace}` : 'in this cluster'}
              </Text>
              <Text style={{ ...Typography.caption1, color: c.textTertiary, textAlign: 'center' }}>
                Stored as Secrets of type helm.sh/release.v1.
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

function ReleaseRow({ release, onPress }: { release: HelmRelease; onPress: () => void }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const statusKind = helmStatusKind(release);
  const dotColor = ({
    ok: c.success, warn: c.warning, bad: c.danger, info: c.info, muted: c.textTertiary,
  } as const)[statusKind ?? 'muted'];

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
      <View style={{ flex: 1 }}>
        <Text style={{ ...Typography.body, color: c.text }} numberOfLines={1}>
          {release.name}
        </Text>
        <Text
          style={{ ...Typography.footnote, color: c.textSecondary }}
          numberOfLines={1}
        >
          {release.chart.name}-{release.chart.version}
          {release.chart.appVersion ? `  ·  app ${release.chart.appVersion}` : ''}
          {'  ·  '}
          {release.namespace}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <Badge text={release.status} colour={dotColor} />
          <Badge text={`rev ${release.version}`} colour={c.textSecondary} />
        </View>
      </View>
      <Text style={{ ...Typography.footnote, color: c.textTertiary }}>
        {release.lastDeployed ? age(release.lastDeployed) : ''}
      </Text>
      <Icon ios="chevron.right" android="chevron_right" size={14} color={c.textTertiary} />
    </Pressable>
  );
}

function Badge({ text, colour }: { text: string; colour: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
        backgroundColor: c.surfaceMuted,
      }}
    >
      <Text style={{ ...Typography.caption2, color: colour, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}
