import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import {
  clearEvents,
  getRecentEvents,
  subscribe,
  type DiagEvent,
} from '@/lib/util/diag';

export default function Diagnostics() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const [events, setEvents] = useState<DiagEvent[]>(() => getRecentEvents());

  useEffect(() => {
    const unsub = subscribe(() => setEvents(getRecentEvents()));
    return unsub;
  }, []);

  function colorFor(e: DiagEvent): string {
    if (e.kind === 'error' || e.kind === 'ws-error') return c.danger;
    if (e.kind === 'response' && e.status >= 400) return c.warning;
    if (e.kind === 'response' || e.kind === 'ws-open') return c.success;
    if (e.kind === 'ws-close') return c.textSecondary;
    return c.textSecondary;
  }

  function summary(e: DiagEvent): string {
    if (e.kind === 'request') return `→ ${e.method} ${e.url}`;
    if (e.kind === 'response')
      return `${e.status} ${e.method} ${e.url} · ${e.ms}ms`;
    if (e.kind === 'ws-open')
      return `⇡ WS open ${e.url}${e.protocol ? ` · ${e.protocol}` : ''}`;
    if (e.kind === 'ws-close')
      return `⇣ WS close ${e.url} · ${e.code} ${e.reason}`;
    if (e.kind === 'ws-error')
      return `✗ WS ${e.url}${e.status ? ` · HTTP ${e.status}` : ''} · ${e.name ?? 'Error'}: ${e.message}`;
    return `✗ ${e.method} ${e.url} · ${e.name ?? 'Error'}: ${e.message}`;
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: 'Diagnostics',
          headerRight: () => (
            <Pressable
              hitSlop={12}
              onPress={() => {
                clearEvents();
                setEvents([]);
              }}
            >
              <Icon ios="trash" android="delete" size={20} color={c.danger} />
            </Pressable>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm }}
        data={[...events].reverse()}
        keyExtractor={(e, i) => `${e.kind}-${e.url}-${i}-${e.ts ?? 0}`}
        ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
        renderItem={({ item }) => (
          <Glass radius={Radii.md} style={{ padding: Spacing.sm }}>
            <Text
              selectable
              style={{
                ...Typography.caption1,
                color: colorFor(item),
                fontFamily: Typography.mono.fontFamily,
              }}
            >
              {summary(item)}
            </Text>
            {item.kind === 'request' ? (
              <Text
                selectable
                style={{
                  ...Typography.caption2,
                  color: c.textTertiary,
                  fontFamily: Typography.mono.fontFamily,
                  marginTop: 4,
                }}
              >
                {Object.entries(item.headers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              </Text>
            ) : null}
            {item.kind === 'response' && item.status >= 400 && item.bodyPreview ? (
              <Text
                selectable
                style={{
                  ...Typography.caption2,
                  color: c.textSecondary,
                  fontFamily: Typography.mono.fontFamily,
                  marginTop: 4,
                }}
              >
                {item.bodyPreview}
              </Text>
            ) : null}
          </Glass>
        )}
        ListEmptyComponent={() => (
          <Text style={{ ...Typography.subhead, color: c.textSecondary, textAlign: 'center', paddingVertical: 40 }}>
            No traffic yet. Try opening a resource list.
          </Text>
        )}
      />
    </View>
  );
}
