import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Linking,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Stack } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';
import { ResourceTable } from '@/components/ResourceTable';
import {
  usePortForwards,
  type PortForwardEntry,
} from '@/lib/state/port-forward-context';
import type { Column } from '@/lib/k8s/row-columns';
import type { RowSummary } from '@/lib/k8s/row-summaries';
import { age } from '@/lib/util/time';
import { Menu, type MenuItemSpec } from '@/components/Menu';

// ── Status mapping ─────────────────────────────────────────────────────────

function statusKind(e: PortForwardEntry): RowSummary['status'] {
  switch (e.status) {
    case 'listening':
      return 'ok';
    case 'error':
      return 'bad';
    case 'closing':
    case 'closed':
      return 'muted';
    case 'starting':
      return 'warn';
    default:
      return 'info';
  }
}

// ── Table columns (iPad / wide view) ───────────────────────────────────────

const PF_COLUMNS: Column<PortForwardEntry>[] = [
  {
    key: 'source',
    label: 'Source',
    render: (e) => `${e.sourceKind.toLowerCase()}/${e.sourceName}`,
    weight: 2,
    minWidth: 140,
    priority: 1,
  },
  {
    key: 'namespace',
    label: 'Namespace',
    render: (e) => e.namespace,
    weight: 1,
    minWidth: 100,
    priority: 3,
  },
  {
    key: 'local',
    label: 'Local port',
    render: (e) => (e.localPort > 0 ? `127.0.0.1:${e.localPort}` : '…'),
    mono: true,
    weight: 1.2,
    minWidth: 110,
    priority: 1,
  },
  {
    key: 'remote',
    label: 'Remote',
    render: (e) => `${e.podName}:${e.remotePort}`,
    mono: true,
    weight: 1.5,
    minWidth: 130,
    priority: 2,
  },
  {
    key: 'status',
    label: 'Status',
    render: (e) => e.status,
    weight: 0.8,
    minWidth: 80,
    priority: 2,
  },
  {
    key: 'bridges',
    label: 'Conn',
    render: (e) => String(e.bridges),
    align: 'right',
    weight: 0.4,
    minWidth: 40,
    priority: 4,
  },
  {
    key: 'age',
    label: 'Age',
    render: (e) => age(new Date(e.startedAt).toISOString()),
    align: 'right',
    weight: 0.6,
    minWidth: 50,
    priority: 3,
  },
];

// ── Screen ─────────────────────────────────────────────────────────────────

export default function PortForwardsScreen() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { forwards, stop, stopAll } = usePortForwards();
  const dims = useWindowDimensions();

  const isIPad =
    Platform.OS === 'ios' &&
    ((Platform as any).isPad === true || Math.min(dims.width, dims.height) >= 768);
  const drawerWidth = isIPad || Math.min(dims.width, dims.height) >= 600 ? 320 : 0;
  const tableViewport = dims.width - drawerWidth;
  const useTable = tableViewport >= 700;

  const [filter, setFilter] = useState('');

  const sorted = useMemo(() => {
    const list = [...forwards].sort((a, b) => b.startedAt - a.startedAt);
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter(
      (e) =>
        e.sourceName.toLowerCase().includes(q) ||
        e.podName.toLowerCase().includes(q) ||
        e.namespace.toLowerCase().includes(q) ||
        String(e.remotePort).includes(q) ||
        String(e.localPort).includes(q),
    );
  }, [forwards, filter]);

  const active = sorted.filter(
    (f) => f.status === 'listening' || f.status === 'starting',
  ).length;

  // Tap on a row → action sheet with Open / Stop / Cancel. Keeps the row
  // visual identical to other list screens (no inline buttons) while still
  // exposing the two actions a forward needs.
  const [menuEntry, setMenuEntry] = useState<PortForwardEntry | null>(null);

  const openInBrowser = useCallback((entry: PortForwardEntry) => {
    if (entry.status !== 'listening' || entry.localPort <= 0) return;
    const url = `http://127.0.0.1:${entry.localPort}`;
    void Linking.openURL(url).catch((e) => {
      Alert.alert('Could not open browser', e?.message ?? String(e));
    });
  }, []);

  const menuItems: MenuItemSpec[] = menuEntry
    ? [
        {
          label: 'Open in Safari',
          icon: { ios: 'safari', android: 'open_in_browser' },
          disabled: menuEntry.status !== 'listening' || menuEntry.localPort <= 0,
          onPress: () => openInBrowser(menuEntry),
        },
        {
          label: `Local: 127.0.0.1:${menuEntry.localPort > 0 ? menuEntry.localPort : '…'}`,
          icon: { ios: 'arrow.left.arrow.right', android: 'swap_horiz' },
          detail: `→ ${menuEntry.podName}:${menuEntry.remotePort}`,
          onPress: () => {},
          disabled: true,
        },
        { kind: 'separator' },
        {
          label: 'Stop forward',
          icon: { ios: 'stop.circle', android: 'stop_circle' },
          destructive: true,
          onPress: () => stop(menuEntry.id),
        },
      ]
    : [];

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
          placeholder="Filter port forwards"
          placeholderTextColor={c.textTertiary}
          autoCorrect={false}
          autoCapitalize="none"
          style={{ flex: 1, color: c.text, fontSize: 15 }}
        />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: 'Port forwards',
          headerLeft: () => <DrawerToggle />,
          headerRight: () =>
            active > 0 ? (
              <Pressable
                hitSlop={10}
                onPress={() =>
                  Alert.alert(
                    'Stop all forwards?',
                    `${active} active forward${active === 1 ? '' : 's'} will be terminated.`,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Stop all', style: 'destructive', onPress: stopAll },
                    ],
                  )
                }
              >
                <Text style={{ ...Typography.subhead, color: c.danger, fontWeight: '600' }}>
                  Stop all
                </Text>
              </Pressable>
            ) : null,
        }}
      />

      <Menu visible={menuEntry != null} onClose={() => setMenuEntry(null)} items={menuItems} />

      {useTable ? (
        <ResourceTable<PortForwardEntry>
          items={sorted}
          columns={PF_COLUMNS}
          width={tableViewport}
          getKey={(e) => e.id}
          getStatus={statusKind}
          refreshing={false}
          onRefresh={() => {}}
          onPressRow={(e) => setMenuEntry(e)}
          emptyIcon={{ ios: 'arrow.left.arrow.right', android: 'swap_horiz' }}
          emptyLabel="No active port forwards"
          listHeader={
            <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm }}>
              {searchHeader}
            </View>
          }
        />
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(e) => e.id}
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
          renderItem={({ item }) => (
            <ForwardRow entry={item} onPress={() => setMenuEntry(item)} />
          )}
          ListEmptyComponent={() => (
            <View style={{ paddingVertical: 40, alignItems: 'center', gap: 8 }}>
              <Icon
                ios="arrow.left.arrow.right"
                android="swap_horiz"
                size={28}
                color={c.textTertiary}
              />
              <Text style={{ color: c.textSecondary, ...Typography.subhead, textAlign: 'center' }}>
                No active port forwards.
              </Text>
              <Text style={{ ...Typography.caption1, color: c.textTertiary, textAlign: 'center' }}>
                Tap a port chip on a Pod or Service to start one.
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}

// ── Phone row ──────────────────────────────────────────────────────────────

function ForwardRow({
  entry,
  onPress,
}: {
  entry: PortForwardEntry;
  onPress: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const kind = statusKind(entry);
  const dot = ({
    ok: c.success, warn: c.warning, bad: c.danger, info: c.info, muted: c.textTertiary,
  } as const)[kind ?? 'muted'];

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
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <View style={{ flex: 1 }}>
        <Text style={{ ...Typography.body, color: c.text }} numberOfLines={1}>
          {entry.sourceKind.toLowerCase()}/{entry.sourceName}
        </Text>
        <Text
          style={{
            ...Typography.footnote,
            color: c.textSecondary,
            fontFamily: Typography.mono.fontFamily,
          }}
          numberOfLines={1}
        >
          {entry.localPort > 0 ? `127.0.0.1:${entry.localPort}` : '…'}  →  {entry.podName}:
          {entry.remotePort}
        </Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
          <Badge text={entry.status} colour={dot} />
          {entry.bridges > 0 ? (
            <Badge text={`${entry.bridges} conn`} colour={c.textSecondary} />
          ) : null}
          <Badge text={entry.namespace} colour={c.textSecondary} />
        </View>
        {entry.error ? (
          <Text
            style={{
              ...Typography.caption1,
              color: c.danger,
              marginTop: 4,
              fontFamily: Typography.mono.fontFamily,
            }}
            numberOfLines={2}
          >
            {entry.error}
          </Text>
        ) : null}
      </View>
      <Text style={{ ...Typography.footnote, color: c.textTertiary }}>
        {age(new Date(entry.startedAt).toISOString())}
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
