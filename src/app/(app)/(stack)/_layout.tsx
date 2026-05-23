import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors } from '@/lib/ui/theme';

// Single Stack underneath the Drawer. iOS gets native translucent / liquid-glass
// nav bars; Android gets the platform-default Material header.
export default function StackLayout() {
  const scheme = useScheme();
  const c = Colors[scheme];

  return (
    <Stack
      screenOptions={{
        // Translucent header so content scrolls under it.
        headerTransparent: Platform.OS === 'ios',
        // On iOS 26 react-native-screens promotes systemChromeMaterial → Liquid Glass automatically.
        headerBlurEffect: 'systemChromeMaterial',
        headerStyle:
          Platform.OS === 'ios'
            ? { backgroundColor: 'transparent' }
            : { backgroundColor: c.background },
        headerTintColor: c.text,
        headerTitleStyle: { color: c.text },
        headerShadowVisible: false,
        // Scroll-edge "soft" gives the iOS 26 fade-into-glass behaviour where content
        // gently blends into the bar at the top edge. Auto for other edges.
        headerLargeStyle: { backgroundColor: 'transparent' },
        contentStyle: { backgroundColor: c.background },
      }}
    />
  );
}
