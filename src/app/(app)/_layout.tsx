import { Platform, useWindowDimensions } from 'react-native';
import { useScheme } from "@/lib/ui/scheme";
import { Drawer } from 'expo-router/drawer';
import { CRDProvider } from '@/lib/state/crds-context';
import { DrawerContent } from '@/components/DrawerContent';
import { Colors } from '@/lib/ui/theme';

export default function AppLayout() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const dims = useWindowDimensions();
  // iPads always get the permanent sidebar regardless of orientation. On
  // Android we infer "isTablet" from short-edge width so a phone in landscape
  // (e.g. 932×430) doesn't masquerade as one.
  const isIPad =
    Platform.OS === 'ios' &&
    ((Platform as any).isPad === true ||
      Math.min(dims.width, dims.height) >= 768);
  const isTablet = isIPad || Math.min(dims.width, dims.height) >= 600;

  return (
    <CRDProvider>
      <Drawer
        drawerContent={(props) => <DrawerContent {...props} />}
        screenOptions={{
          drawerType: isTablet ? 'permanent' : 'slide',
          drawerStyle: {
            backgroundColor: c.background,
            width: isTablet ? 320 : Math.min(dims.width * 0.82, 360),
            borderRightWidth: isTablet ? 1 : 0,
            borderRightColor: c.separator,
          },
          headerShown: false,
          overlayColor: 'rgba(0,0,0,0.35)',
          drawerActiveTintColor: c.accent,
          drawerInactiveTintColor: c.text,
          sceneStyle: { backgroundColor: c.background },
        }}
      />
    </CRDProvider>
  );
}
