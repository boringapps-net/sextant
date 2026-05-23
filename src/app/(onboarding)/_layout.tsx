import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors } from '@/lib/ui/theme';

export default function OnboardingLayout() {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Stack
      screenOptions={{
        headerTransparent: Platform.OS === 'ios',
        headerBlurEffect: 'systemChromeMaterial',
        headerStyle:
          Platform.OS === 'ios'
            ? { backgroundColor: 'transparent' }
            : { backgroundColor: c.background },
        headerTintColor: c.text,
        headerTitleStyle: { color: c.text },
        headerShadowVisible: false,
        headerLargeStyle: { backgroundColor: 'transparent' },
        contentStyle: { backgroundColor: c.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false, title: 'Sextant' }} />
      <Stack.Screen
        name="add-cluster"
        options={{ title: 'Add cluster', headerBackTitle: 'Sextant' }}
      />
    </Stack>
  );
}
