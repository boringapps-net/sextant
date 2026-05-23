import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useScheme } from '@/lib/ui/scheme';
import { useClusters } from '@/lib/state/cluster-context';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import type { StreamHandle } from 'expo-k8s-mtls';

const TAIL_LINES = 500;
// Hard ceiling on lines kept in memory. Old lines fall off the top.
const MAX_LINES = 5000;
// Treat as "near bottom" if user is within this many pixels of the end.
const STICKY_THRESHOLD = 80;

export default function PodLogs() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const headerHeight = useHeaderHeight();
  const { name, namespace } = useLocalSearchParams<{ name: string; namespace?: string }>();
  const { client } = useClusters();

  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | undefined>();
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'closed' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [filter, setFilter] = useState('');

  // Holds the partial line at the end of the buffer between chunk arrivals.
  const partial = useRef('');
  const handle = useRef<StreamHandle | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Track whether the user is parked near the bottom; if so, auto-scroll on new lines.
  const stickToBottom = useRef(true);

  // Discover containers once.
  useEffect(() => {
    if (!client || !name) return;
    const def = { apiGroup: '', apiVersion: 'v1', plural: 'pods', namespaced: true };
    client
      .get<any>(def, name, namespace)
      .then((pod) => {
        const all = [
          ...(pod.spec?.initContainers ?? []),
          ...(pod.spec?.containers ?? []),
        ].map((cn: any) => cn.name);
        setContainers(all);
        setContainer((prev) => prev ?? all[0]);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [client, name, namespace]);

  // (Re)open the stream whenever container or timestamps changes.
  useEffect(() => {
    if (!client || !name || !namespace || !container) return;
    handle.current?.stop();
    setLines([]);
    partial.current = '';
    setError(null);
    setStatus('connecting');

    const h = client.podLogsStream(
      namespace,
      name,
      { container, tailLines: TAIL_LINES, timestamps },
      {
        onChunk: (chunk) => {
          // Re-split on newlines. Hold any unterminated trailing fragment over.
          const combined = partial.current + chunk;
          const parts = combined.split('\n');
          partial.current = parts.pop() ?? '';
          if (parts.length === 0) return;
          setStatus('live');
          setLines((prev) => {
            const next = prev.length + parts.length > MAX_LINES
              ? [...prev, ...parts].slice(-MAX_LINES)
              : [...prev, ...parts];
            return next;
          });
        },
        onDone: ({ cancelled }) => {
          if (!cancelled) setStatus('closed');
        },
        onError: (err) => {
          setError(`${err.name ?? 'Error'}: ${err.message}`);
          setStatus('error');
        },
      },
    );
    handle.current = h;
    return () => h.stop();
  }, [client, name, namespace, container, timestamps]);

  // Auto-scroll to end on new lines when sticky.
  useEffect(() => {
    if (follow && stickToBottom.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    }
  }, [lines.length, follow]);

  const visibleLines = useMemo(() => {
    if (!filter.trim()) return lines;
    const q = filter.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, filter]);

  function pickContainer() {
    if (containers.length === 0) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...containers, 'Cancel'], cancelButtonIndex: containers.length },
        (idx) => {
          if (idx < containers.length) setContainer(containers[idx]);
        },
      );
    }
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height);
    stickToBottom.current = distanceFromBottom <= STICKY_THRESHOLD;
  }

  function reconnect() {
    // Touch container value to force the effect to re-run.
    if (container) {
      const cur = container;
      setContainer(undefined);
      setTimeout(() => setContainer(cur), 0);
    }
  }

  function jumpToEnd() {
    stickToBottom.current = true;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }

  const liveColor =
    status === 'live' ? c.success : status === 'connecting' ? c.warning : status === 'error' ? c.danger : c.textTertiary;
  const statusLabel =
    status === 'live'
      ? 'Live'
      : status === 'connecting'
      ? 'Connecting'
      : status === 'closed'
      ? 'Closed'
      : status === 'error'
      ? 'Error'
      : 'Idle';

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: `${name ?? ''} · logs` }} />

      {/* Controls bar — pushed below the transparent header */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: headerHeight + 4, gap: 8 }}>
        <Glass radius={Radii.md} style={{ padding: Spacing.sm, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable
              onPress={pickContainer}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: c.surfaceMuted,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: Radii.pill,
              }}
            >
              <Icon ios="cube" android="layers" size={14} color={c.text} />
              <Text style={{ ...Typography.footnote, color: c.text, fontWeight: '600' }}>
                {container ?? '—'}
              </Text>
              <Icon ios="chevron.down" android="expand_more" size={12} color={c.textSecondary} />
            </Pressable>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: liveColor,
                }}
              />
              <Text style={{ ...Typography.caption1, color: c.textSecondary }}>{statusLabel}</Text>
            </View>
            <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Auto-scroll</Text>
            <Switch value={follow} onValueChange={setFollow} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: c.surfaceMuted,
                borderRadius: Radii.sm,
                paddingHorizontal: 8,
                flex: 1,
                height: 32,
                gap: 4,
              }}
            >
              <Icon ios="magnifyingglass" android="search" size={13} color={c.textSecondary} />
              <TextInput
                value={filter}
                onChangeText={setFilter}
                placeholder="Filter lines"
                placeholderTextColor={c.textTertiary}
                style={{ flex: 1, color: c.text, fontSize: 13 }}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <Pressable
              onPress={() => setTimestamps((t) => !t)}
              style={{
                paddingHorizontal: 10,
                height: 32,
                borderRadius: Radii.sm,
                backgroundColor: timestamps ? c.accentSubtle : c.surfaceMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  ...Typography.caption1,
                  color: timestamps ? c.accent : c.textSecondary,
                  fontWeight: '600',
                }}
              >
                TS
              </Text>
            </Pressable>
            <Pressable
              onPress={reconnect}
              style={{
                paddingHorizontal: 10,
                height: 32,
                borderRadius: Radii.sm,
                backgroundColor: c.surfaceMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon ios="arrow.clockwise" android="refresh" size={14} color={c.text} />
            </Pressable>
          </View>
        </Glass>
      </View>

      {error ? (
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm }}>
          <Text style={{ color: c.danger, ...Typography.subhead }}>{error}</Text>
        </View>
      ) : null}

      {status === 'connecting' && lines.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <ScrollView
            ref={scrollRef}
            style={{ flex: 1, marginTop: Spacing.sm }}
            contentContainerStyle={{ paddingHorizontal: Spacing.lg, paddingBottom: 24 }}
            onScroll={onScroll}
            scrollEventThrottle={64}
          >
            <View style={{ paddingVertical: Spacing.sm }}>
              {visibleLines.length === 0 ? (
                <Text style={{ color: c.textTertiary }}>
                  {status === 'live' ? 'Waiting for log lines…' : 'No log lines.'}
                </Text>
              ) : (
                <Text
                  selectable
                  style={{
                    fontFamily: Typography.mono.fontFamily,
                    fontSize: 11.5,
                    lineHeight: 16,
                    color: c.text,
                  }}
                >
                  {visibleLines.join('\n')}
                </Text>
              )}
            </View>
          </ScrollView>

          {/* Floating "jump to live" button — appears when user has scrolled up. */}
          {follow && !stickToBottom.current && status === 'live' ? (
            <Pressable
              onPress={jumpToEnd}
              style={{
                position: 'absolute',
                bottom: 20,
                alignSelf: 'center',
                backgroundColor: c.accent,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: Radii.pill,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Icon ios="arrow.down" android="arrow_downward" size={13} color="#fff" />
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Jump to live</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
