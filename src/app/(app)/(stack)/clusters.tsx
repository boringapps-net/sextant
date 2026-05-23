import { Alert, FlatList, Pressable, Text, View, } from 'react-native';
import { useScheme } from "@/lib/ui/scheme";
import { Stack, useRouter } from 'expo-router';
import { useClusters } from '@/lib/state/cluster-context';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { DrawerToggle } from '@/components/Header';

export default function Clusters() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  const { clusters, active, activate, remove } = useClusters();

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: 'Clusters',
          headerLeft: () => <DrawerToggle />,
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable
                onPress={() => router.push('/(app)/(stack)/diagnostics' as any)}
                hitSlop={12}
              >
                <Icon ios="stethoscope" android="bug_report" size={20} color={c.accent} />
              </Pressable>
              <Pressable
                onPress={() => router.push('/(onboarding)/add-cluster')}
                hitSlop={12}
              >
                <Icon ios="plus" android="add" size={20} color={c.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, gap: Spacing.sm }}
        data={clusters}
        keyExtractor={(c) => c.id}
        ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
        renderItem={({ item }) => {
          const focused = active?.id === item.id;
          return (
            <Glass radius={Radii.lg}>
              <Pressable
                onPress={() => activate(item.id)}
                style={({ pressed }) => ({
                  padding: Spacing.md,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: Spacing.md,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 12,
                    backgroundColor: focused ? c.accentSubtle : c.surfaceMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon ios="server.rack" android="dns" size={20} color={focused ? c.accent : c.textSecondary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ ...Typography.headline, color: c.text }} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={{ ...Typography.caption1, color: c.textSecondary }} numberOfLines={1}>
                    {item.server}
                  </Text>
                </View>
                {focused ? (
                  <Icon ios="checkmark.circle.fill" android="check_circle" size={20} color={c.accent} />
                ) : null}
                <Pressable
                  hitSlop={10}
                  onPress={() =>
                    Alert.alert('Remove cluster?', `"${item.name}" will be deleted from this device.`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => remove(item.id) },
                    ])
                  }
                  style={{ paddingHorizontal: 6 }}
                >
                  <Icon ios="trash" android="delete" size={18} color={c.danger} />
                </Pressable>
              </Pressable>
            </Glass>
          );
        }}
        ListFooterComponent={() => (
          <Pressable
            onPress={() => router.push('/(onboarding)/add-cluster')}
            style={({ pressed }) => ({
              marginTop: Spacing.lg,
              backgroundColor: pressed ? c.accent + 'CC' : c.accent,
              paddingVertical: 14,
              borderRadius: Radii.lg,
              alignItems: 'center',
              flexDirection: 'row',
              justifyContent: 'center',
              gap: 8,
            })}
          >
            <Icon ios="plus" android="add" size={18} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 16 }}>Add cluster</Text>
          </Pressable>
        )}
      />
    </View>
  );
}
