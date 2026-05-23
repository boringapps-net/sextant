import React, { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { MetricsCard } from './MetricsCard';
import { useClusters } from '@/lib/state/cluster-context';
import { useTimeSeries } from '@/lib/state/use-time-series';
import { K8sError } from '@/lib/k8s/client';
import { formatBytes, formatCores, formatPercent, parseQuantity } from '@/lib/k8s/quantity';
import type { K8sObject } from '@/lib/k8s/types';

type Props =
  | { kind: 'Pod'; name: string; namespace: string; pod: K8sObject }
  | { kind: 'Node'; name: string; node: K8sObject };

// Sums container CPU+memory for a single pod into one number each.
function podTotals(pod: { containers?: { usage?: { cpu?: string; memory?: string } }[] }) {
  let cpu = 0;
  let mem = 0;
  for (const cnt of pod.containers ?? []) {
    cpu += parseQuantity(cnt.usage?.cpu);
    mem += parseQuantity(cnt.usage?.memory);
  }
  return { cpu, mem };
}

export function MetricsRow(props: Props) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const { client } = useClusters();

  // Build polling fetchers up front so each useTimeSeries gets a stable identity.
  const fetchCpu = useCallback(
    async (signal: AbortSignal): Promise<number | null> => {
      if (!client) return null;
      try {
        if (props.kind === 'Pod') {
          const m = await client.getPodMetrics(props.namespace, props.name, signal);
          return podTotals(m).cpu;
        }
        const m = await client.getNodeMetrics(props.name, signal);
        return parseQuantity(m.usage?.cpu);
      } catch (e) {
        if (e instanceof K8sError && e.status === 404) return null;
        throw e;
      }
    },
    [client, props],
  );

  const fetchMem = useCallback(
    async (signal: AbortSignal): Promise<number | null> => {
      if (!client) return null;
      try {
        if (props.kind === 'Pod') {
          const m = await client.getPodMetrics(props.namespace, props.name, signal);
          return podTotals(m).mem;
        }
        const m = await client.getNodeMetrics(props.name, signal);
        return parseQuantity(m.usage?.memory);
      } catch (e) {
        if (e instanceof K8sError && e.status === 404) return null;
        throw e;
      }
    },
    [client, props],
  );

  const { points: cpuPoints, error: cpuErr } = useTimeSeries(fetchCpu, { intervalMs: 5000 });
  const { points: memPoints, error: memErr } = useTimeSeries(fetchMem, { intervalMs: 5000 });

  // Resource limits / capacity for percentage context.
  let cpuCap: number | undefined;
  let memCap: number | undefined;
  if (props.kind === 'Node') {
    const status: any = props.node.status ?? {};
    const cap = status.allocatable ?? status.capacity ?? {};
    cpuCap = cap.cpu ? parseQuantity(cap.cpu) : undefined;
    memCap = cap.memory ? parseQuantity(cap.memory) : undefined;
  } else {
    // Pod: sum container limits if any container has them.
    const spec: any = props.pod.spec ?? {};
    let cpuLim = 0;
    let memLim = 0;
    let hasAny = false;
    for (const cnt of spec.containers ?? []) {
      const lim = cnt.resources?.limits ?? {};
      if (lim.cpu) {
        cpuLim += parseQuantity(lim.cpu);
        hasAny = true;
      }
      if (lim.memory) {
        memLim += parseQuantity(lim.memory);
        hasAny = true;
      }
    }
    if (hasAny) {
      cpuCap = cpuLim || undefined;
      memCap = memLim || undefined;
    }
  }

  const latestCpu = cpuPoints[cpuPoints.length - 1]?.v;
  const latestMem = memPoints[memPoints.length - 1]?.v;

  if (cpuErr || memErr) {
    const msg = cpuErr ?? memErr ?? '';
    // 403 means our token doesn't have access to metrics; 404 means no metrics-server.
    // Both surface as a soft notice instead of an inline error noise.
    if (/forbidden|unauthorized/i.test(msg)) {
      return (
        <MetricsNotice
          icon="lock"
          title="Metrics not available"
          body="Your token does not have access to the metrics.k8s.io API."
        />
      );
    }
  }

  if (
    !cpuErr &&
    !memErr &&
    cpuPoints.length === 0 &&
    memPoints.length === 0
  ) {
    return (
      <MetricsNotice
        icon="chart.line.uptrend.xyaxis"
        title="Waiting for metrics"
        body="metrics-server typically reports every 15s. If nothing appears, it may not be installed in this cluster."
      />
    );
  }

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
        Live metrics
      </Text>
      <View style={{ flexDirection: 'row', gap: Spacing.md }}>
        <MetricsCard
          title="CPU"
          value={latestCpu !== undefined ? formatCores(latestCpu) : '…'}
          subtitle={
            cpuCap !== undefined && latestCpu !== undefined
              ? `of ${formatCores(cpuCap)} · ${formatPercent(latestCpu / cpuCap)}`
              : props.kind === 'Pod'
              ? 'no limit set'
              : undefined
          }
          points={cpuPoints}
          color={c.info}
          yMax={cpuCap}
        />
        <MetricsCard
          title="Memory"
          value={latestMem !== undefined ? formatBytes(latestMem) : '…'}
          subtitle={
            memCap !== undefined && latestMem !== undefined
              ? `of ${formatBytes(memCap)} · ${formatPercent(latestMem / memCap)}`
              : props.kind === 'Pod'
              ? 'no limit set'
              : undefined
          }
          points={memPoints}
          color={c.accent}
          yMax={memCap}
        />
      </View>
    </View>
  );
}

function MetricsNotice({ icon, title, body }: { icon: string; title: string; body: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Glass radius={Radii.lg} style={{ padding: Spacing.md, flexDirection: 'row', gap: Spacing.sm }}>
      <Icon ios={icon} android="show_chart" size={18} color={c.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text style={{ ...Typography.headline, color: c.text }}>{title}</Text>
        <Text style={{ ...Typography.footnote, color: c.textSecondary, marginTop: 2 }}>
          {body}
        </Text>
      </View>
    </Glass>
  );
}
