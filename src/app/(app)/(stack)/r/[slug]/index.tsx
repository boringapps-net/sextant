import { useMemo, useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useClusters } from '@/lib/state/cluster-context';
import { useCRDs } from '@/lib/state/crds-context';
import { useWatchedList } from '@/lib/state/use-watched-list';
import { BUILTIN_RESOURCES, parseSlug, type ResourceDef } from '@/lib/k8s/resources';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';
import { summarize, type RowSummary } from '@/lib/k8s/row-summaries';
import type { K8sObject } from '@/lib/k8s/types';
import { columnsFor } from '@/lib/k8s/row-columns';
import { ResourceTable } from '@/components/ResourceTable';

export default function ResourceList() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { activeNamespace } = useClusters();
  const { crds } = useCRDs();
  const dims = useWindowDimensions();
  // Table view kicks in once we have iPad-ish width (matches drawer detection).
  const isIPad =
    Platform.OS === 'ios' &&
    ((Platform as any).isPad === true ||
      Math.min(dims.width, dims.height) >= 768);
  // The drawer claims 320px when permanent, so account for it.
  const drawerWidth = isIPad || Math.min(dims.width, dims.height) >= 600 ? 320 : 0;
  const tableViewport = dims.width - drawerWidth;
  const useTable = tableViewport >= 700;
  const [filter, setFilter] = useState('');

  const def: ResourceDef | undefined = useMemo(() => {
    if (!slug) return undefined;
    const builtin = BUILTIN_RESOURCES.find((r) => r.slug === slug);
    if (builtin) return builtin;
    // CRD slug: "<plural>.<group>"
    const { plural, apiGroup } = parseSlug(slug);
    return crds.find((r) => r.plural === plural && r.apiGroup === apiGroup);
  }, [slug, crds]);

  // Live list: an initial LIST seeds the items, then a WATCH keeps them in
  // sync via ADDED / MODIFIED / DELETED events. The hook keeps items in a
  // Map<uid,T> internally so MODIFIED only changes the affected row's
  // reference — every other FlatList row keeps a stable `item` prop and
  // doesn't re-render, so no layout shifts.
  const { items, loading, error } = useWatchedList(def, {
    namespace: def?.namespaced ? activeNamespace : undefined,
  });

  const filtered = useMemo(() => {
    if (!filter.trim()) return items;
    const q = filter.toLowerCase();
    return items.filter(
      (i) =>
        i.metadata.name.toLowerCase().includes(q) ||
        (i.metadata.namespace ?? '').toLowerCase().includes(q),
    );
  }, [items, filter]);

  if (!def) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <Stack.Screen options={{ title: 'Not found' }} />
        <View style={{ padding: Spacing.lg }}>
          <Text style={{ ...Typography.body, color: c.text }}>
            Unknown resource. CRDs may still be loading — open the drawer to refresh.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: `${def.kind}s`,
          headerLeft: () => <DrawerToggle />,
        }}
      />

      {loading && items.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : useTable ? (
        <ResourceTable<K8sObject>
          items={filtered}
          columns={columnsFor(def.kind, def.namespaced)}
          width={tableViewport}
          getKey={(o) => o.metadata.uid ?? `${o.metadata.namespace}/${o.metadata.name}`}
          getStatus={(o) => summarize(def.kind, o).status}
          // The watch keeps data live, so pull-to-refresh is mostly cosmetic;
          // we never have a "refreshing" state to show. Force-flicker would
          // actually defeat the live updates, so this is a no-op spinner.
          refreshing={false}
          onRefresh={() => {}}
          onPressRow={(item) => {
            const namePart = encodeURIComponent(item.metadata.name);
            const nsPart = item.metadata.namespace
              ? `?namespace=${encodeURIComponent(item.metadata.namespace)}`
              : '';
            router.push(`/(app)/(stack)/r/${def.slug}/${namePart}${nsPart}` as any);
          }}
          emptyIcon={def.icon}
          emptyLabel={`No ${def.kind.toLowerCase()}s`}
          listHeader={
            <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
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
                  placeholder={`Filter ${def.kind.toLowerCase()}s`}
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
          }
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.metadata.uid ?? `${i.metadata.namespace}/${i.metadata.name}`}
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
                <Icon
                  ios="magnifyingglass"
                  android="search"
                  size={15}
                  color={c.textSecondary}
                />
                <TextInput
                  value={filter}
                  onChangeText={setFilter}
                  placeholder={`Filter ${def.kind.toLowerCase()}s`}
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
          }
          ItemSeparatorComponent={() => (
            <View style={{ height: 0.5, backgroundColor: c.separator, marginLeft: 14 }} />
          )}
          // Watch keeps data live; pull-to-refresh has no work to do but we
          // keep the control mounted so the gesture isn't lost.
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={() => {}} tintColor={c.text} />
          }
          renderItem={({ item }) => {
            const s = summarize(def.kind, item);
            const namePart = encodeURIComponent(item.metadata.name);
            const nsPart = item.metadata.namespace
              ? `?namespace=${encodeURIComponent(item.metadata.namespace)}`
              : '';
            return (
              <Pressable
                onPress={() =>
                  router.push(`/(app)/(stack)/r/${def.slug}/${namePart}${nsPart}` as any)
                }
                style={({ pressed }) => ({
                  paddingVertical: 12,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <StatusDot status={s.status} />
                <View style={{ flex: 1 }}>
                  <Text style={{ ...Typography.body, color: c.text }} numberOfLines={1}>
                    {s.primary}
                  </Text>
                  {s.secondary ? (
                    <Text style={{ ...Typography.footnote, color: c.textSecondary }} numberOfLines={1}>
                      {s.secondary}
                    </Text>
                  ) : null}
                  {s.badges?.length ? (
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                      {s.badges.map((b, i) => (
                        <View
                          key={i}
                          style={{
                            paddingHorizontal: 6,
                            paddingVertical: 1,
                            borderRadius: 4,
                            backgroundColor: c.surfaceMuted,
                          }}
                        >
                          <Text style={{ ...Typography.caption2, color: c.textSecondary }}>{b}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
                <Text style={{ ...Typography.footnote, color: c.textTertiary }}>{s.tertiary}</Text>
                <Icon ios="chevron.right" android="chevron_right" size={14} color={c.textTertiary} />
              </Pressable>
            );
          }}
          ListEmptyComponent={() => (
            <View style={{ paddingVertical: 40, alignItems: 'center', gap: 8 }}>
              <Icon ios={def.icon.ios} android={def.icon.android} size={28} color={c.textTertiary} />
              <Text style={{ color: c.textSecondary, ...Typography.subhead }}>
                No {def.kind.toLowerCase()}s
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

function StatusDot({ status }: { status: RowSummary['status'] }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const map: Record<NonNullable<RowSummary['status']>, string> = {
    ok: c.success,
    warn: c.warning,
    bad: c.danger,
    info: c.info,
    muted: c.textTertiary,
  };
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: map[status ?? 'muted'],
      }}
    />
  );
}
