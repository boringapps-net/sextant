import React, { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Line as SvgLine } from 'react-native-svg';
import type { Point } from '@/lib/state/use-time-series';

type Props = {
  points: Point[];
  width: number;
  height: number;
  // Stroke + area fill. Area is the same color at low alpha.
  color: string;
  // Optional y-axis ceiling (e.g. capacity). When set, the chart is scaled
  // against this value instead of the data min/max, which gives "% of capacity"
  // visualisations and a stable baseline across refreshes.
  yMax?: number;
  // Optional zero baseline. Defaults to 0 (we generally graph >=0 metrics).
  yMin?: number;
  // Show a faint axis line at the top of the chart.
  showCeiling?: boolean;
};

// Lightweight SVG sparkline. We use a single Path for the line, a closed Path
// for the area fill, and (optionally) a faint horizontal rule at the ceiling.
export function Sparkline({
  points,
  width,
  height,
  color,
  yMax,
  yMin = 0,
  showCeiling = false,
}: Props) {
  const { linePath, areaPath } = useMemo(() => {
    if (points.length === 0) return { linePath: '', areaPath: '' };

    const minT = points[0].t;
    const maxT = points[points.length - 1].t;
    const tSpan = Math.max(1, maxT - minT);

    const dataMax = Math.max(...points.map((p) => p.v));
    const top = yMax ?? Math.max(dataMax, 1);
    const bottom = yMin;
    const vSpan = Math.max(1e-9, top - bottom);

    // Pad slightly so strokes aren't clipped at the edges.
    const padY = 2;
    const inner = height - padY * 2;

    const xy = (p: Point): [number, number] => {
      const x = points.length === 1 ? width / 2 : ((p.t - minT) / tSpan) * width;
      const yClamped = Math.min(Math.max(p.v, bottom), top);
      const y = padY + inner - ((yClamped - bottom) / vSpan) * inner;
      return [x, y];
    };

    const segs = points.map(xy);
    const linePath = segs
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
      .join(' ');
    const first = segs[0];
    const last = segs[segs.length - 1];
    const areaPath = `${linePath} L${last[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z`;
    return { linePath, areaPath };
  }, [points, width, height, yMax, yMin]);

  if (points.length === 0) {
    return <View style={{ width, height }} />;
  }

  return (
    <Svg width={width} height={height}>
      {showCeiling && yMax !== undefined ? (
        <SvgLine
          x1={0}
          y1={2}
          x2={width}
          y2={2}
          stroke={color}
          strokeOpacity={0.25}
          strokeDasharray="3,3"
        />
      ) : null}
      <Path d={areaPath} fill={color} fillOpacity={0.18} />
      <Path d={linePath} stroke={color} strokeWidth={1.5} fill="none" />
    </Svg>
  );
}
