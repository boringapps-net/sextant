import React from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Sparkline } from './Sparkline';
import type { Point } from '@/lib/state/use-time-series';

type Props = {
  title: string;
  // Current / display value e.g. "1.2 cores" or "512 MiB".
  value: string;
  // Optional context line: "of 4.0 cores (30%)".
  subtitle?: string;
  points: Point[];
  color: string;
  // Optional cap for the chart's y-axis (e.g. node capacity).
  yMax?: number;
};

// One metric: title + value + sparkline + optional context. Wraps everything
// in our Glass surface so it matches the rest of the app.
export function MetricsCard({ title, value, subtitle, points, color, yMax }: Props) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { width } = useWindowDimensions();
  // Cards typically sit two-up; budget for outer padding and gap.
  const chartWidth = Math.floor((width - Spacing.lg * 2 - Spacing.md) / 2) - Spacing.md * 2;

  return (
    <Glass radius={Radii.lg} style={{ padding: Spacing.md, minWidth: 0, flex: 1 }}>
      <Text style={{ ...Typography.footnote, color: c.textSecondary, fontWeight: '600' }}>
        {title}
      </Text>
      <Text style={{ ...Typography.title3, color: c.text, marginTop: 2 }}>{value}</Text>
      {subtitle ? (
        <Text style={{ ...Typography.caption1, color: c.textTertiary, marginTop: 1 }}>
          {subtitle}
        </Text>
      ) : null}
      <View style={{ marginTop: Spacing.sm }}>
        <Sparkline
          points={points}
          width={Math.max(80, chartWidth)}
          height={44}
          color={color}
          yMax={yMax}
          showCeiling={yMax !== undefined}
        />
      </View>
    </Glass>
  );
}
