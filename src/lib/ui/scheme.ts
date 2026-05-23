import { useColorScheme as rnUseColorScheme } from 'react-native';
import type { ColorScheme } from './theme';

// React Native's hook may return null or 'unspecified'.
// We narrow to the only two values our theme defines.
export function useScheme(): ColorScheme {
  const s = rnUseColorScheme();
  return s === 'dark' ? 'dark' : 'light';
}
