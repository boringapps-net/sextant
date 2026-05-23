import React from 'react';
import { useScheme } from "@/lib/ui/scheme";
import { Platform, StyleSheet, View, ViewProps } from 'react-native';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Colors, Radii } from './theme';
import { } from 'react-native';

// True when the device actually renders Apple's liquid glass (iOS 26+).
const LIQUID_AVAILABLE = Platform.OS === 'ios' && isLiquidGlassAvailable();

type GlassProps = ViewProps & {
  // 'regular' is the standard frosted look; 'clear' is the see-through chrome.
  variant?: 'regular' | 'clear';
  interactive?: boolean;
  radius?: number;
};

// A drop-in glass surface that prefers expo-glass-effect on iOS 26+,
// and renders a tinted/blurred fallback elsewhere.
export function Glass({
  variant = 'regular',
  interactive,
  radius = Radii.lg,
  style,
  children,
  ...rest
}: GlassProps) {
  const scheme = useScheme();
  if (LIQUID_AVAILABLE) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        style={[{ borderRadius: radius, overflow: 'hidden' }, style]}
        {...rest}
      >
        {children}
      </GlassView>
    );
  }
  // Fallback: solid tint that approximates the look without a heavy blur dep.
  const tint = Colors[scheme].glassTint;
  return (
    <View
      style={[
        {
          backgroundColor: tint,
          borderRadius: radius,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: Colors[scheme].border,
          overflow: 'hidden',
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export const liquidGlassAvailable = LIQUID_AVAILABLE;
