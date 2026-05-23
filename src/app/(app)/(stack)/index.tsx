import { useCallback, useEffect, useMemo, useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useClusters } from '@/lib/state/cluster-context';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';
import { ClusterMetricsCard } from '@/components/ClusterMetricsCard';
import { BUILTIN_RESOURCES } from '@/lib/k8s/resources';

const HEADLINE_KINDS = ['Pod', 'Deployment', 'Service', 'Node'] as const;

export default function Overview() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { active, client, activeNamespace } = useClusters();
  const router = useRouter();
  const [counts, setCounts] = useState<Partial<Record<string, number>>>({});
  const [version, setVersion] = useState<{ gitVersion: string; platform: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headline = useMemo(
    () => HEADLINE_KINDS.map((k) => BUILTIN_RESOURCES.find((r) => r.kind === k)!).filter(Boolean),
    [],
  );

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const ctrl = new AbortController();
      const [v, ...rest] = await Promise.allSettled([
        client.ping(ctrl.signal),
        ...headline.map((r) =>
          client.list(r, { namespace: r.namespaced ? activeNamespace : undefined, signal: ctrl.signal, limit: 500 }),
        ),
      ]);
      if (v.status === 'fulfilled') setVersion(v.value);
      const next: Record<string, number> = {};
      rest.forEach((res, i) => {
        if (res.status === 'fulfilled') next[headline[i].kind] = res.value.items.length;
      });
      setCounts(next);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [client, headline, activeNamespace]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: active?.name ?? 'Sextant',
          headerLeft: () => <DrawerToggle />,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.md }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={c.text} />}
      >
        {error ? (
          <Glass radius={Radii.lg} style={{ padding: Spacing.md, flexDirection: 'row', gap: Spacing.sm }}>
            <Icon ios="exclamationmark.triangle" android="warning" size={20} color={c.danger} />
            <Text style={{ ...Typography.callout, color: c.text, flex: 1 }}>{error}</Text>
          </Glass>
        ) : null}

        <ClusterMetricsCard />

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md }}>
          {headline.map((r) => (
            <Pressable
              key={r.slug}
              onPress={() => router.push(`/(app)/(stack)/r/${r.slug}` as any)}
              style={{ flexGrow: 1, flexBasis: '45%' }}
            >
              <Glass radius={Radii.lg} style={{ padding: Spacing.md, minHeight: 96 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon ios={r.icon.ios} android={r.icon.android} size={18} color={c.accent} />
                  <Text style={{ ...Typography.footnote, color: c.textSecondary, fontWeight: '600' }}>
                    {r.kind}s
                  </Text>
                </View>
                <Text style={{ ...Typography.largeTitle, color: c.text, marginTop: 6 }}>
                  {counts[r.kind] ?? (loading ? '…' : '—')}
                </Text>
                <Text style={{ ...Typography.caption1, color: c.textTertiary, marginTop: 2 }}>
                  {r.namespaced && activeNamespace ? `in ${activeNamespace}` : 'cluster-wide'}
                </Text>
              </Glass>
            </Pressable>
          ))}
        </View>

        <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
          <Text style={{ ...Typography.headline, color: c.text, marginBottom: 6 }}>Quick actions</Text>
          {[
            { icon: 'cube.box', label: 'Pods', slug: 'pods' },
            { icon: 'square.stack.3d.up', label: 'Deployments', slug: 'deployments' },
            { icon: 'bell.badge', label: 'Recent events', slug: 'events' },
            { icon: 'server.rack', label: 'Nodes', slug: 'nodes' },
          ].map((item, idx) => (
            <Pressable
              key={item.slug}
              onPress={() => router.push(`/(app)/(stack)/r/${item.slug}` as any)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 12,
                borderTopWidth: idx === 0 ? 0 : 0.5,
                borderTopColor: c.separator,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Icon ios={item.icon} android="apps" size={18} color={c.accent} />
              <Text style={{ ...Typography.body, color: c.text, flex: 1 }}>{item.label}</Text>
              <Icon ios="chevron.right" android="chevron_right" size={14} color={c.textTertiary} />
            </Pressable>
          ))}
        </Glass>
      </ScrollView>
    </View>
  );
}
