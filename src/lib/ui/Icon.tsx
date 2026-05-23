import React from 'react';
import { SymbolView } from 'expo-symbols';

// Thin wrapper over SymbolView with sensible defaults.
// Types are loose: many Material Symbols / SF Symbols outside the typed union still work at runtime.
export function Icon({
  ios,
  android,
  size = 20,
  color,
}: {
  ios: string;
  android: string;
  size?: number;
  color?: string;
}) {
  return (
    <SymbolView
      name={{ ios: ios as never, android: android as never, web: android as never }}
      size={size}
      tintColor={color}
      style={{ width: size, height: size }}
      resizeMode="scaleAspectFit"
    />
  );
}
