// App-wide tokens. Pulled from Apple HIG / Material 3 baselines with custom accents.
// We expose a `useColors()` hook from app state that resolves light/dark.

import { Platform } from 'react-native';

export const Colors = {
  light: {
    background: '#F2F2F7',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    surfaceMuted: 'rgba(118,118,128,0.08)',
    border: 'rgba(60,60,67,0.18)',
    separator: 'rgba(60,60,67,0.10)',
    text: '#000000',
    textSecondary: 'rgba(60,60,67,0.6)',
    textTertiary: 'rgba(60,60,67,0.4)',
    accent: '#3B7DDD',           // K8s blue (slightly desaturated)
    accentSubtle: 'rgba(59,125,221,0.12)',
    success: '#34C759',
    warning: '#FF9F0A',
    danger: '#FF3B30',
    info: '#5AC8FA',
    glassTint: 'rgba(255,255,255,0.7)',
  },
  dark: {
    background: '#000000',
    surface: '#1C1C1E',
    surfaceElevated: '#2C2C2E',
    surfaceMuted: 'rgba(120,120,128,0.16)',
    border: 'rgba(84,84,88,0.65)',
    separator: 'rgba(84,84,88,0.32)',
    text: '#FFFFFF',
    textSecondary: 'rgba(235,235,245,0.6)',
    textTertiary: 'rgba(235,235,245,0.3)',
    accent: '#5E9CFF',
    accentSubtle: 'rgba(94,156,255,0.16)',
    success: '#30D158',
    warning: '#FF9F0A',
    danger: '#FF453A',
    info: '#64D2FF',
    glassTint: 'rgba(28,28,30,0.55)',
  },
} as const;

export type ColorScheme = keyof typeof Colors;
export type Palette = (typeof Colors)[ColorScheme];

export const Radii = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const Typography = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, letterSpacing: 0.37 },
  title1: { fontSize: 28, fontWeight: '700' as const, letterSpacing: 0.36 },
  title2: { fontSize: 22, fontWeight: '700' as const, letterSpacing: 0.35 },
  title3: { fontSize: 20, fontWeight: '600' as const, letterSpacing: 0.38 },
  headline: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.41 },
  body: { fontSize: 17, fontWeight: '400' as const, letterSpacing: -0.41 },
  callout: { fontSize: 16, fontWeight: '400' as const, letterSpacing: -0.32 },
  subhead: { fontSize: 15, fontWeight: '400' as const, letterSpacing: -0.24 },
  footnote: { fontSize: 13, fontWeight: '400' as const, letterSpacing: -0.08 },
  caption1: { fontSize: 12, fontWeight: '400' as const, letterSpacing: 0 },
  caption2: { fontSize: 11, fontWeight: '500' as const, letterSpacing: 0.07 },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
  },
} as const;
