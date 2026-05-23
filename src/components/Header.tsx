import { Pressable } from 'react-native';
import { useNavigation } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors } from '@/lib/ui/theme';
import { Icon } from '@/lib/ui/Icon';

type DrawerNav = { toggleDrawer?: () => void };

// Opens the drawer. Use as `headerLeft={() => <DrawerToggle />}` on screens
// that should sit at the root of the Stack (i.e. drawer destinations).
export function DrawerToggle() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const nav = useNavigation() as unknown as DrawerNav;
  return (
    <Pressable
      hitSlop={12}
      onPress={() => nav.toggleDrawer?.()}
      style={{ paddingHorizontal: 4 }}
    >
      <Icon ios="line.3.horizontal" android="menu" size={20} color={c.text} />
    </Pressable>
  );
}
