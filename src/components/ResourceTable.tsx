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
import type { K8sObject } from '@/lib/k8s/types';
import { summarize, type RowSummary } from '@/lib/k8s/row-summaries';

type Props = {
  items: K8sObject[];
  kind: string;
  columns: Column[];
  width: number;
  // What comes above the table — search bar + error card, etc.
  listHeader?: React.ReactElement | null;
  refreshing: boolean;
  onRefresh: () => void;
  onPressRow: (item: K8sObject) => void;
  emptyIcon?: { ios: string; android: string };
  emptyLabel?: string;
};

// Pick columns that fit. `priority` orders the drop sequence (higher = drop first).
// The first column is always kept.
function chooseColumns(columns: Column[], available: number): Column[] {
  // Sort descending by priority so we drop in that order.
  const dropOrder = [...columns]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 1) - (a.c.priority ?? 1));

  // Start with everything; while overflow, drop the next entry.
  const keep = new Set(columns.map((c) => c.key));
  const minWidth = (c: Column) => c.minWidth ?? 80;
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

export function ResourceTable({
  items,
  kind,
  columns,
  width,
  listHeader,
  refreshing,
  onRefresh,
  onPressRow,
  emptyIcon,
  emptyLabel,
}: Props) {
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
    <FlatList
      data={items}
      keyExtractor={(i) => i.metadata.uid ?? `${i.metadata.namespace}/${i.metadata.name}`}
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
          kind={kind}
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

function TableRow({
  item,
  kind,
  columns,
  totalWeight,
  onPress,
}: {
  item: K8sObject;
  kind: string;
  columns: Column[];
  totalWeight: number;
  onPress: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const s = summarize(kind, item);
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
        <StatusDot status={s.status} />
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
