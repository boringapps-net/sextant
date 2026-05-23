import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useScheme } from "@/lib/ui/scheme";
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';

export default function Welcome() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: Spacing.xl, justifyContent: 'center' }}>
        <View style={{ alignItems: 'center', marginBottom: Spacing.xxl }}>
          <Image
            source={require('../../../assets/icon.png')}
            style={{ width: 96, height: 96, borderRadius: 22, marginBottom: Spacing.lg }}
          />
          <Text style={{ ...Typography.title1, color: c.text }}>Sextant</Text>
          <Text style={{ ...Typography.subhead, color: c.textSecondary, marginTop: 6, textAlign: 'center' }}>
            A mobile Kubernetes client. Everything runs on your device — no servers, no proxies.
          </Text>
        </View>

        <Glass radius={Radii.xl} style={{ padding: Spacing.lg, gap: Spacing.md }}>
          <FeatureRow icon="cube.box" color={c.accent} title="Browse workloads" subtitle="Pods, Deployments, StatefulSets, Jobs and more" />
          <FeatureRow icon="text.viewfinder" color={c.info} title="Live logs" subtitle="Tail container logs from any pod" />
          <FeatureRow icon="slider.horizontal.3" color={c.warning} title="Scale & restart" subtitle="Take action on workloads without kubectl" />
          <FeatureRow icon="cube.transparent" color={c.success} title="Full CRD support" subtitle="Every custom resource your operators expose" />
        </Glass>

        <Pressable
          onPress={() => router.push('/(onboarding)/add-cluster')}
          style={({ pressed }) => ({
            marginTop: Spacing.xl,
            backgroundColor: pressed ? c.accent + 'CC' : c.accent,
            paddingVertical: 16,
            borderRadius: Radii.lg,
            alignItems: 'center',
          })}
        >
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 17 }}>Add your first cluster</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function FeatureRow({
  icon,
  color,
  title,
  subtitle,
}: {
  icon: string;
  color: string;
  title: string;
  subtitle: string;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          backgroundColor: color + '22',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon ios={icon} android="extension" size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ ...Typography.headline, color: c.text }}>{title}</Text>
        <Text style={{ ...Typography.footnote, color: c.textSecondary, marginTop: 2 }}>{subtitle}</Text>
      </View>
    </View>
  );
}
