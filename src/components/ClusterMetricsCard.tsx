import React, { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { MetricsCard } from './MetricsCard';
import { useClusters } from '@/lib/state/cluster-context';
import { useTimeSeries } from '@/lib/state/use-time-series';
import { K8sError } from '@/lib/k8s/client';
import { BUILTIN_RESOURCES } from '@/lib/k8s/resources';
import {
  formatBytes,
  formatCores,
  formatPercent,
  parseQuantity,
} from '@/lib/k8s/quantity';

export function ClusterMetricsCard() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { client } = useClusters();
  // Total cluster capacity (sum of allocatable across nodes). Refreshed once
  // per mount — capacity doesn't change often, no need to re-fetch every tick.
  const [capacity, setCapacity] = useState<{ cpu: number; mem: number } | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const ctrl = new AbortController();
    const def = BUILTIN_RESOURCES.find((r) => r.kind === 'Node')!;
    client
      .list<any>(def, { signal: ctrl.signal })
      .then((res) => {
        let cpu = 0;
        let mem = 0;
        for (const node of res.items) {
          const cap = node.status?.allocatable ?? node.status?.capacity ?? {};
          cpu += parseQuantity(cap.cpu);
          mem += parseQuantity(cap.memory);
        }
        setCapacity({ cpu, mem });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [client]);

  const fetchCpu = useCallback(
    async (signal: AbortSignal) => {
      if (!client) return null;
      try {
        const m = await client.listNodeMetrics(signal);
        return m.items.reduce((acc, n) => acc + parseQuantity(n.usage?.cpu), 0);
      } catch (e) {
        if (e instanceof K8sError && (e.status === 404 || e.status === 403)) {
          setUnavailable(e.status === 404 ? 'metrics-server not installed' : 'access denied');
          return null;
        }
        throw e;
      }
    },
    [client],
  );
  const fetchMem = useCallback(
    async (signal: AbortSignal) => {
      if (!client) return null;
      try {
        const m = await client.listNodeMetrics(signal);
        return m.items.reduce((acc, n) => acc + parseQuantity(n.usage?.memory), 0);
      } catch {
        return null;
      }
    },
    [client],
  );

  const cpu = useTimeSeries(fetchCpu, { intervalMs: 10_000 });
  const mem = useTimeSeries(fetchMem, { intervalMs: 10_000 });

  if (unavailable) {
    return (
      <Glass radius={Radii.lg} style={{ padding: Spacing.md, flexDirection: 'row', gap: Spacing.sm }}>
        <Icon ios="chart.line.uptrend.xyaxis" android="show_chart" size={18} color={c.textTertiary} />
        <View style={{ flex: 1 }}>
          <Text style={{ ...Typography.headline, color: c.text }}>Cluster metrics</Text>
          <Text style={{ ...Typography.footnote, color: c.textSecondary, marginTop: 2 }}>
            Unavailable — {unavailable}
          </Text>
        </View>
      </Glass>
    );
  }

  const latestCpu = cpu.points[cpu.points.length - 1]?.v;
  const latestMem = mem.points[mem.points.length - 1]?.v;

  return (
    <View style={{ gap: Spacing.sm }}>
      <Text
        style={{
          ...Typography.footnote,
          color: c.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.7,
          paddingHorizontal: 4,
        }}
      >
        Cluster utilisation
      </Text>
      <View style={{ flexDirection: 'row', gap: Spacing.md }}>
        <MetricsCard
          title="CPU"
          value={latestCpu !== undefined ? formatCores(latestCpu) : '…'}
          subtitle={
            capacity && latestCpu !== undefined
              ? `of ${formatCores(capacity.cpu)} · ${formatPercent(latestCpu / capacity.cpu)}`
              : undefined
          }
          points={cpu.points}
          color={c.info}
          yMax={capacity?.cpu}
        />
        <MetricsCard
          title="Memory"
          value={latestMem !== undefined ? formatBytes(latestMem) : '…'}
          subtitle={
            capacity && latestMem !== undefined
              ? `of ${formatBytes(capacity.mem)} · ${formatPercent(latestMem / capacity.mem)}`
              : undefined
          }
          points={mem.points}
          color={c.accent}
          yMax={capacity?.mem}
        />
      </View>
    </View>
  );
}
