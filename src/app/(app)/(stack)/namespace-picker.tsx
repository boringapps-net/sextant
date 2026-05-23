import { useEffect, useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
import { ActivityIndicator, FlatList, Pressable, Text, View, } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useClusters } from '@/lib/state/cluster-context';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { BUILTIN_RESOURCES } from '@/lib/k8s/resources';

export default function NamespacePicker() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { client, activeNamespace, setNamespace } = useClusters();
  const router = useRouter();
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const ctrl = new AbortController();
    const def = BUILTIN_RESOURCES.find((r) => r.kind === 'Namespace')!;
    client
      .list(def, { signal: ctrl.signal })
      .then((res) => {
        setNamespaces(res.items.map((i: any) => i.metadata.name).sort());
        setLoading(false);
      })
      .catch((e) => {
        setError(e?.message ?? String(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [client]);

  function pick(ns?: string) {
    void setNamespace(ns);
    router.back();
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: 'Namespace' }} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : error ? (
        <View style={{ padding: Spacing.lg }}>
          <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
            <Text style={{ color: c.text }}>{error}</Text>
          </Glass>
        </View>
      ) : (
        <FlatList
          data={[null, ...namespaces]}
          keyExtractor={(ns) => ns ?? '__all__'}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: 40 }}
          ItemSeparatorComponent={() => (
            <View style={{ height: 0.5, backgroundColor: c.separator, marginLeft: 50 }} />
          )}
          renderItem={({ item }) => {
            const focused = (item ?? undefined) === activeNamespace;
            return (
              <Pressable
                onPress={() => pick(item ?? undefined)}
                style={({ pressed }) => ({
                  paddingVertical: 14,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: Spacing.md,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Icon
                  ios={item === null ? 'square.grid.3x3' : 'folder'}
                  android={item === null ? 'apps' : 'folder'}
                  size={20}
                  color={focused ? c.accent : c.textSecondary}
                />
                <Text
                  style={{
                    ...Typography.body,
                    color: focused ? c.accent : c.text,
                    fontWeight: focused ? '600' : '400',
                    flex: 1,
                  }}
                >
                  {item ?? 'All namespaces'}
                </Text>
                {focused ? <Icon ios="checkmark" android="check" size={16} color={c.accent} /> : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}
