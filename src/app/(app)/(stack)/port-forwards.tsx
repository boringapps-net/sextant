import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';
import { usePortForwards, type PortForwardEntry } from '@/lib/state/port-forward-context';

export default function PortForwardsScreen() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { forwards, stop, stopAll } = usePortForwards();

  // Sort newest-first so the most recent action is at the top — matches
  // expectations from kubectl-style tools where the last forward is what
  // you usually want to interact with.
  const sorted = [...forwards].sort((a, b) => b.startedAt - a.startedAt);
  const active = sorted.filter((f) => f.status === 'listening' || f.status === 'starting');

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: 'Port forwards',
          headerLeft: () => <DrawerToggle />,
          headerRight: () =>
            active.length > 0 ? (
              <Pressable
                hitSlop={10}
                onPress={() =>
                  Alert.alert(
                    'Stop all forwards?',
                    `${active.length} active forward${active.length === 1 ? '' : 's'} will be terminated.`,
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

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60, gap: Spacing.md }}
      >
        {sorted.length === 0 ? (
          <Glass radius={Radii.lg} style={{ padding: Spacing.lg, alignItems: 'center', gap: 8 }}>
            <Icon ios="arrow.left.arrow.right" android="swap_horiz" size={28} color={c.textTertiary} />
            <Text style={{ ...Typography.subhead, color: c.textSecondary, textAlign: 'center' }}>
              No active port forwards.
            </Text>
            <Text style={{ ...Typography.caption1, color: c.textTertiary, textAlign: 'center' }}>
              Tap a port chip on a pod or service to start one.
            </Text>
          </Glass>
        ) : (
          sorted.map((f) => <ForwardRow key={f.id} entry={f} onStop={() => stop(f.id)} />)
        )}
      </ScrollView>
    </View>
  );
}

function ForwardRow({
  entry,
  onStop,
}: {
  entry: PortForwardEntry;
  onStop: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];

  const statusColor =
    entry.status === 'listening'
      ? c.success
      : entry.status === 'error'
      ? c.danger
      : entry.status === 'closing' || entry.status === 'closed'
      ? c.textTertiary
      : c.warning;

  const canOpen = entry.status === 'listening' && entry.localPort > 0;

  function openInBrowser() {
    if (!canOpen) return;
    const url = `http://127.0.0.1:${entry.localPort}`;
    void Linking.openURL(url).catch((e) => {
      Alert.alert('Could not open browser', e?.message ?? String(e));
    });
  }

  return (
    <Glass radius={Radii.lg} style={{ padding: Spacing.md, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusColor }} />
        <Text style={{ ...Typography.headline, color: c.text, flex: 1 }} numberOfLines={1}>
          {entry.sourceKind.toLowerCase()}/{entry.sourceName}
        </Text>
        <Text style={{ ...Typography.caption1, color: c.textSecondary }}>
          {entry.namespace}
        </Text>
      </View>
      <Text
        style={{
          ...Typography.subhead,
          color: c.text,
          fontFamily: Typography.mono.fontFamily,
        }}
      >
        127.0.0.1:{entry.localPort > 0 ? entry.localPort : '…'}
        <Text style={{ color: c.textTertiary }}>  →  </Text>
        {entry.podName}:{entry.remotePort}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 }}>
        <Text style={{ ...Typography.caption1, color: c.textSecondary }}>
          {entry.status === 'starting'
            ? 'Starting…'
            : entry.status === 'listening'
            ? entry.bridges > 0
              ? `${entry.bridges} active connection${entry.bridges === 1 ? '' : 's'}`
              : 'Ready'
            : entry.status === 'closing'
            ? 'Stopping…'
            : entry.status === 'closed'
            ? 'Closed'
            : 'Error'}
        </Text>
        {entry.error ? (
          <Text
            style={{
              ...Typography.caption1,
              color: c.danger,
              flex: 1,
              fontFamily: Typography.mono.fontFamily,
            }}
            numberOfLines={2}
          >
            {entry.error}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm }}>
        <Pressable
          disabled={!canOpen}
          onPress={openInBrowser}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            backgroundColor: canOpen ? c.accentSubtle : c.surfaceMuted,
            paddingVertical: 9,
            borderRadius: Radii.md,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon ios="safari" android="open_in_browser" size={15} color={canOpen ? c.accent : c.textTertiary} />
          <Text
            style={{
              ...Typography.subhead,
              color: canOpen ? c.accent : c.textTertiary,
              fontWeight: '600',
            }}
          >
            Open
          </Text>
        </Pressable>
        <Pressable
          onPress={onStop}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            backgroundColor: c.danger + '22',
            paddingVertical: 9,
            borderRadius: Radii.md,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon ios="stop.circle" android="stop_circle" size={15} color={c.danger} />
          <Text style={{ ...Typography.subhead, color: c.danger, fontWeight: '600' }}>
            Stop
          </Text>
        </Pressable>
      </View>
    </Glass>
  );
}
