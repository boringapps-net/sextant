import React, { useMemo } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Icon } from '@/lib/ui/Icon';
import { Glass } from '@/lib/ui/glass';
import type { Column } from '@/lib/k8s/row-columns';
import type { RowSummary } from '@/lib/k8s/row-summaries';

// Generic — works for any item type, not just K8sObject. Callers pass
// getKey + getStatus to bridge into their domain. Used by R-list (with
// K8sObject), helm list (HelmRelease), and port-forwards (PortForwardEntry).
type Props<T> = {
  items: T[];
  columns: Column<T>[];
  width: number;
  // What comes above the table — search bar + error card, etc.
  listHeader?: React.ReactElement | null;
  refreshing: boolean;
  onRefresh: () => void;
  onPressRow: (item: T) => void;
  // Per-item stable key + status colour for the left-edge dot.
  getKey: (item: T) => string;
  getStatus: (item: T) => RowSummary['status'];
  emptyIcon?: { ios: string; android: string };
  emptyLabel?: string;
};

// Pick columns that fit. `priority` orders the drop sequence (higher = drop first).
// The first column is always kept.
function chooseColumns<T>(columns: Column<T>[], available: number): Column<T>[] {
  // Sort descending by priority so we drop in that order.
  const dropOrder = [...columns]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 1) - (a.c.priority ?? 1));

  // Start with everything; while overflow, drop the next entry.
  const keep = new Set(columns.map((c) => c.key));
  const minWidth = (c: Column<T>) => c.minWidth ?? 80;
  let used = columns.reduce((n, c) => n + minWidth(c), 0);
  for (const { c } of dropOrder) {
    if (used <= available) break;
    if (c.priority === 1) continue; // never drop essentials
    if (keep.size <= 2) break; // always keep at least name + one extra
    keep.delete(c.key);
    used -= minWidth(c);
  }
  return columns.filter((c) => keep.has(c.key));
}

const CELL_PADDING = Spacing.sm;
const STATUS_DOT_WIDTH = 16; // dot + gap

export function ResourceTable<T>({
  items,
  columns,
  width,
  listHeader,
  refreshing,
  onRefresh,
  onPressRow,
  getKey,
  getStatus,
  emptyIcon,
  emptyLabel,
}: Props<T>) {
  const scheme = useScheme();
  const c = Colors[scheme];

  const visibleCols = useMemo(() => {
    // Reserve space for our left status indicator + outer padding.
    const reserved = STATUS_DOT_WIDTH + Spacing.lg * 2;
    return chooseColumns(columns, Math.max(0, width - reserved));
  }, [columns, width]);

  const totalWeight = useMemo(
    () => visibleCols.reduce((n, col) => n + (col.weight ?? 1), 0),
    [visibleCols],
  );

  const TableHeader = (
    <View style={{ backgroundColor: c.background, paddingTop: Spacing.sm }}>
      {listHeader}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: Spacing.lg,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.separator,
          gap: Spacing.sm,
          backgroundColor: c.background,
        }}
      >
        <View style={{ width: STATUS_DOT_WIDTH }} />
        {visibleCols.map((col) => (
          <View
            key={col.key}
            style={{
              flex: col.weight ?? 1,
              paddingHorizontal: CELL_PADDING,
              alignItems: col.align === 'right' ? 'flex-end' : 'flex-start',
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                ...Typography.caption2,
                color: c.textSecondary,
                fontWeight: '700',
                textTransform: 'uppercase',
                letterSpacing: 0.7,
              }}
            >
              {col.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );

  return (
    <FlatList<T>
      data={items}
      keyExtractor={getKey}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: 60 }}
      stickyHeaderIndices={[0]}
      ListHeaderComponent={TableHeader}
      ItemSeparatorComponent={() => (
        <View style={{ height: StyleSheetHairline, backgroundColor: c.separator, marginLeft: Spacing.lg + STATUS_DOT_WIDTH }} />
      )}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text} />
      }
      renderItem={({ item }) => (
        <TableRow
          item={item}
          status={getStatus(item)}
          columns={visibleCols}
          totalWeight={totalWeight}
          onPress={() => onPressRow(item)}
        />
      )}
      ListEmptyComponent={
        <View style={{ paddingVertical: 60, alignItems: 'center', gap: 8 }}>
          {emptyIcon ? (
            <Icon ios={emptyIcon.ios} android={emptyIcon.android} size={28} color={c.textTertiary} />
          ) : null}
          <Text style={{ color: c.textSecondary, ...Typography.subhead }}>{emptyLabel ?? 'No results'}</Text>
        </View>
      }
    />
  );
}

const StyleSheetHairline = Platform.select({ ios: 0.5, default: 1 }) as number;

function TableRow<T>({
  item,
  status,
  columns,
  totalWeight,
  onPress,
}: {
  item: T;
  status: RowSummary['status'];
  columns: Column<T>[];
  totalWeight: number;
  onPress: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Spacing.lg,
        paddingVertical: 10,
        gap: Spacing.sm,
        backgroundColor: pressed ? c.surfaceMuted : 'transparent',
      })}
    >
      <View style={{ width: STATUS_DOT_WIDTH, alignItems: 'flex-start' }}>
        <StatusDot status={status} />
      </View>
      {columns.map((col) => (
        <View
          key={col.key}
          style={{
            flex: col.weight ?? 1,
            paddingHorizontal: CELL_PADDING,
            alignItems: col.align === 'right' ? 'flex-end' : 'flex-start',
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              ...Typography.subhead,
              color: c.text,
              fontFamily: col.mono ? Typography.mono.fontFamily : undefined,
            }}
          >
            {col.render(item)}
          </Text>
        </View>
      ))}
    </Pressable>
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
