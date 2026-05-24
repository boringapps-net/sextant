import 'react-native-gesture-handler';
import { useScheme } from "@/lib/ui/scheme";
import { useEffect } from 'react';
import { } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { ClusterProvider, useClusters } from '@/lib/state/cluster-context';
import { PortForwardProvider } from '@/lib/state/port-forward-context';
import { Colors } from '@/lib/ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function Gate({ children }: { children: React.ReactNode }) {
  const { loading, clusters } = useClusters();
  const router = useRouter();
  const segments = useSegments() as string[];

  useEffect(() => {
    if (loading) return;
    SplashScreen.hideAsync().catch(() => {});
    const inOnboarding = segments[0] === '(onboarding)';
    if (clusters.length === 0 && !inOnboarding) {
      router.replace('/(onboarding)');
    } else if (clusters.length > 0 && inOnboarding) {
      router.replace('/(app)/(stack)');
    }
  }, [loading, clusters, segments, router]);

  return <>{children}</>;
}

export default function RootLayout() {
  const scheme = useScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: Colors[scheme].background }}>
      <SafeAreaProvider>
        <ClusterProvider>
          <PortForwardProvider>
            <Gate>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(app)" />
                <Stack.Screen name="(onboarding)" />
              </Stack>
              <StatusBar style="auto" />
            </Gate>
          </PortForwardProvider>
        </ClusterProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
