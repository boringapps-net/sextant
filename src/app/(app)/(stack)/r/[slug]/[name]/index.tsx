import { useCallback, useMemo, useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useClusters } from '@/lib/state/cluster-context';
import { useCRDs } from '@/lib/state/crds-context';
import {
  apiGroupFromVersion,
  BUILTIN_RESOURCES,
  findResourceByKindGroup,
  parseSlug,
  type ResourceDef,
} from '@/lib/k8s/resources';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import type { K8sObject } from '@/lib/k8s/types';
import { age } from '@/lib/util/time';
import { toYaml } from '@/lib/util/yaml';
import { MetricsRow } from '@/components/MetricsRow';
import { Menu, type MenuItemSpec } from '@/components/Menu';
import { summarize, type RowSummary } from '@/lib/k8s/row-summaries';
import { useWatchedItem } from '@/lib/state/use-watched-item';
import { useStartPortForward } from '@/lib/state/port-forward-context';
import {
  identifyVolumeSource,
  probeToText,
  resolveFieldPath,
  tolerationToText,
  type VolumeSource,
} from '@/lib/k8s/pod-derivations';

type Tab = 'overview' | 'yaml';

export default function ResourceDetail() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  const { slug, name, namespace } = useLocalSearchParams<{
    slug: string;
    name: string;
    namespace?: string;
  }>();
  const { client } = useClusters();
  const { crds } = useCRDs();
  const [tab, setTab] = useState<Tab>('overview');
  const [actionBusy, setActionBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const def: ResourceDef | undefined = useMemo(() => {
    if (!slug) return undefined;
    const builtin = BUILTIN_RESOURCES.find((r) => r.slug === slug);
    if (builtin) return builtin;
    const { plural, apiGroup } = parseSlug(slug);
    return crds.find((r) => r.plural === plural && r.apiGroup === apiGroup);
  }, [slug, crds]);

  // Live single-resource subscription: initial GET seeds the object, then a
  // name-filtered WATCH keeps it in sync. MODIFIED events replace `obj` in
  // place, so the metrics row, container statuses, conditions etc. all
  // reflect the cluster's current state without polling and without
  // re-mounting children (the K8sObject reference changes but the tree
  // around it doesn't, so the chrome stays put).
  const { item: obj, loading, error } = useWatchedItem<K8sObject>(def, name, namespace);

  // `load()` was the manual refresher. With watch + reconnect it's redundant,
  // but Menu items still expect a function; we keep a stub that triggers a
  // fresh GET via the existing client.get path.
  const load = useCallback(async () => {
    /* no-op: data is live via useWatchedItem */
  }, []);

  async function scale(replicas: number) {
    if (!client || !def || !name) return;
    setActionBusy(true);
    try {
      await client.patch(def, name, { spec: { replicas } }, {
        namespace,
        subresource: 'scale',
        contentType: 'application/merge-patch+json',
      });
      await load();
    } catch (e: any) {
      Alert.alert('Scale failed', e?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  // `kubectl rollout restart` mechanic: stamp spec.template.metadata.annotations
  // with a timestamp so the controller creates a new ReplicaSet/generation.
  async function rolloutRestart() {
    if (!client || !def || !name) return;
    setActionBusy(true);
    try {
      await client.patch(
        def,
        name,
        {
          spec: {
            template: {
              metadata: {
                annotations: {
                  'kubectl.kubernetes.io/restartedAt': new Date().toISOString(),
                },
              },
            },
          },
        },
        { namespace, contentType: 'application/strategic-merge-patch+json' },
      );
      await load();
    } catch (e: any) {
      Alert.alert('Rollout restart failed', e?.message ?? String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function deletePod() {
    if (!client || !def || !name) return;
    Alert.alert('Delete pod?', 'It will be recreated by its controller if any.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setActionBusy(true);
          try {
            await client.delete(def, name, namespace);
            router.back();
          } catch (e: any) {
            Alert.alert('Delete failed', e?.message ?? String(e));
          } finally {
            setActionBusy(false);
          }
        },
      },
    ]);
  }

  async function deleteResource() {
    if (!client || !def || !name) return;
    Alert.alert(`Delete ${def.kind.toLowerCase()}?`, `"${name}" — this can not be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setActionBusy(true);
          try {
            await client.delete(def, name, namespace, {
              propagationPolicy: 'Background',
            });
            router.back();
          } catch (e: any) {
            Alert.alert('Delete failed', e?.message ?? String(e));
          } finally {
            setActionBusy(false);
          }
        },
      },
    ]);
  }

  function chooseScale() {
    const current = (obj?.spec as any)?.replicas ?? 0;
    const options = [0, 1, 2, 3, 5, 10].filter((n) => n !== current);
    const labels = options.map((n) => `Scale to ${n}`).concat(['Cancel']);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: labels, cancelButtonIndex: labels.length - 1, title: `Currently: ${current}` },
        (idx) => {
          if (idx < options.length) void scale(options[idx]);
        },
      );
    } else {
      const buttons = [
        ...options.map((n) => ({ text: `${n}`, onPress: () => scale(n) })),
        { text: 'Cancel', style: 'cancel' as const },
      ];
      Alert.alert(`Scale ${name}`, `Currently: ${current}`, buttons);
    }
  }

  // Per-kind capability flags. Cheap to compute and feed the action-list helpers.
  const isPod = def?.kind === 'Pod';
  const isScalable = !!def && ['Deployment', 'StatefulSet', 'ReplicaSet'].includes(def.kind);
  const isRollable = !!def && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(def.kind);
  const isEditableData = def?.kind === 'Secret' || def?.kind === 'ConfigMap';

  if (!def) return null;

  // Routes that pushed actions take. Kept as plain helpers so we can wire
  // them in both the inline action bar and the ⋯ menu without duplication.
  const goLogs = () =>
    router.push(`/(app)/(stack)/r/${def!.slug}/${encodeURIComponent(name!)}/logs?namespace=${encodeURIComponent(namespace ?? '')}` as any);
  const goShell = () =>
    router.push(`/(app)/(stack)/r/${def!.slug}/${encodeURIComponent(name!)}/exec?namespace=${encodeURIComponent(namespace ?? '')}` as any);
  const goEditData = () =>
    router.push(`/(app)/(stack)/r/${def!.slug}/${encodeURIComponent(name!)}/edit-data?namespace=${encodeURIComponent(namespace ?? '')}` as any);

  // ── Action lists ─────────────────────────────────────────────────────────
  // Primary actions appear as accent-coloured pills in the action bar.
  // The ⋯ menu repeats primary actions at the top, then separator, then
  // secondary stuff (view yaml / refresh / delete) — same actions, two
  // surfaces, no duplication of logic.
  type Primary = {
    label: string;
    icon: { ios: string; android: string };
    onPress: () => void;
    /** Destructive-tinted (red). Used for Restart pod (it's a delete). */
    destructive?: boolean;
  };

  const primary: Primary[] = [];
  if (isPod) {
    primary.push({ label: 'Logs', icon: { ios: 'text.viewfinder', android: 'description' }, onPress: goLogs });
    primary.push({ label: 'Shell', icon: { ios: 'terminal', android: 'terminal' }, onPress: goShell });
    primary.push({ label: 'Restart', icon: { ios: 'arrow.clockwise', android: 'restart_alt' }, onPress: deletePod, destructive: true });
  }
  if (isScalable) {
    primary.push({ label: 'Scale', icon: { ios: 'slider.horizontal.3', android: 'tune' }, onPress: chooseScale });
  }
  if (isRollable) {
    primary.push({ label: 'Rollout', icon: { ios: 'arrow.triangle.2.circlepath', android: 'sync' }, onPress: rolloutRestart });
  }
  if (isEditableData) {
    primary.push({ label: 'Edit data', icon: { ios: 'pencil', android: 'edit' }, onPress: goEditData });
  }

  const menuItems: MenuItemSpec[] = [];
  for (const p of primary) {
    menuItems.push({
      label: p.destructive && p.label === 'Restart' ? 'Restart (delete pod)' : p.label,
      icon: p.icon,
      onPress: p.onPress,
      destructive: p.destructive,
    });
  }
  if (primary.length > 0) menuItems.push({ kind: 'separator' });
  menuItems.push({ label: 'View YAML', icon: { ios: 'doc.text', android: 'description' }, onPress: () => setTab('yaml') });
  menuItems.push({ label: 'Refresh', icon: { ios: 'arrow.clockwise.circle', android: 'refresh' }, onPress: load });
  menuItems.push({ kind: 'separator' });
  menuItems.push({
    label: `Delete ${def.kind.toLowerCase()}…`,
    icon: { ios: 'trash', android: 'delete' },
    onPress: isPod ? deletePod : deleteResource,
    destructive: true,
  });

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: name ?? '',
          headerBackTitle: 'Back',
          headerRight: () => (
            <Pressable hitSlop={12} onPress={() => setMenuOpen(true)}>
              <Icon ios="ellipsis.circle" android="more_vert" size={20} color={c.accent} />
            </Pressable>
          ),
        }}
      />

      <Menu visible={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />

      {loading && !obj ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          // The tab switcher is the sticky element — facts row and action
          // bar scroll away (action bar is still reachable via the ⋯ menu).
          stickyHeaderIndices={[2]}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={load} tintColor={c.text} />
          }
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          {/* 0: Status + quick facts */}
          {obj ? (
            <StatusFactsRow def={def} obj={obj} />
          ) : (
            <View />
          )}

          {/* 1: Primary action bar — accent-tinted pills, scrolls away */}
          {primary.length > 0 ? (
            <ActionBar actions={primary} busy={actionBusy} />
          ) : (
            <View />
          )}

          {/* 2: Sticky tab switcher */}
          <View
            style={{
              backgroundColor: c.background,
              paddingHorizontal: Spacing.lg,
              paddingTop: Spacing.xs,
              paddingBottom: Spacing.sm,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                padding: 4,
                borderRadius: Radii.md,
                backgroundColor: c.surfaceMuted,
              }}
            >
              {(['overview', 'yaml'] as Tab[]).map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTab(t)}
                  style={{
                    flex: 1,
                    paddingVertical: 6,
                    borderRadius: Radii.sm,
                    backgroundColor: tab === t ? c.surface : 'transparent',
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      ...Typography.subhead,
                      color: tab === t ? c.text : c.textSecondary,
                      fontWeight: '600',
                    }}
                  >
                    {t === 'overview' ? 'Overview' : 'YAML'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* 3: Tab body */}
          {error ? (
            <View style={{ padding: Spacing.lg }}>
              <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
                <Text style={{ color: c.danger, ...Typography.subhead }}>{error}</Text>
              </Glass>
            </View>
          ) : !obj ? null : tab === 'overview' ? (
            <OverviewBody obj={obj} def={def} />
          ) : (
            <YamlBody text={toYaml(obj)} />
          )}
        </ScrollView>
      )}
    </View>
  );
}

// ── Status + quick facts row ───────────────────────────────────────────────
// Compact at-a-glance summary: coloured status dot, status text, then a list
// of kind-appropriate facts separated by middle dots.
function StatusFactsRow({ def, obj }: { def: ResourceDef; obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];

  const { statusText, statusKind, facts } = useMemo(
    () => buildHeaderSummary(def, obj),
    [def, obj],
  );

  const dotColor = ({
    ok: c.success, warn: c.warning, bad: c.danger, info: c.info, muted: c.textTertiary,
  } as const)[statusKind];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.sm,
        paddingBottom: 2,
        gap: 6,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
      <Text style={{ ...Typography.subhead, color: c.text, fontWeight: '600' }}>
        {statusText}
      </Text>
      {facts.map((f, i) => (
        <Text key={i} style={{ ...Typography.footnote, color: c.textSecondary }}>
          <Text style={{ color: c.textTertiary }}> · </Text>
          {f}
        </Text>
      ))}
    </View>
  );
}

function buildHeaderSummary(
  def: ResourceDef,
  obj: K8sObject,
): {
  statusText: string;
  statusKind: NonNullable<RowSummary['status']>;
  facts: string[];
} {
  // Reuse the list-row summariser as the single source of truth for status,
  // then add per-kind extras (node, version, etc.) that aren't in list rows.
  const s = summarize(def.kind, obj);
  const meta = obj.metadata;
  const spec: any = obj.spec ?? {};
  const stat: any = obj.status ?? {};

  const facts: string[] = [];
  if (meta.namespace) facts.push(meta.namespace);
  facts.push(age(meta.creationTimestamp));

  if (def.kind === 'Pod' && spec.nodeName) facts.push(spec.nodeName);
  if (def.kind === 'Node') {
    const v = stat.nodeInfo?.kubeletVersion;
    if (v) facts.push(v);
  }
  if (def.kind === 'Service' && spec.type) facts.push(spec.type);
  if (typeof spec.replicas === 'number') {
    facts.unshift(`${stat.readyReplicas ?? 0}/${spec.replicas} ready`);
  }

  // Pull a status-text from the summariser's badges/secondary when possible,
  // else use the kind.
  let statusText = '—';
  if (def.kind === 'Pod') {
    const cs: any[] = stat.containerStatuses ?? [];
    const waiting = cs.find((x) => x.state?.waiting)?.state?.waiting?.reason;
    statusText = waiting ?? stat.phase ?? def.kind;
  } else if (def.kind === 'Node') {
    statusText = (stat.conditions ?? []).find((cond: any) => cond.type === 'Ready')?.status === 'True'
      ? 'Ready' : 'NotReady';
  } else if (stat.phase) {
    statusText = stat.phase;
  } else {
    statusText = def.kind;
  }

  return { statusText, statusKind: s.status ?? 'muted', facts };
}

// ── Inline action bar ──────────────────────────────────────────────────────
// Equal-width accent-tinted pills. Tap = run the action. Press feedback is
// the standard tap dim. Destructive actions get a warning tint instead of
// accent so Restart looks different from Logs/Shell.
function ActionBar({
  actions,
  busy,
}: {
  actions: Array<{
    label: string;
    icon: { ios: string; android: string };
    onPress: () => void;
    destructive?: boolean;
  }>;
  busy: boolean;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: Spacing.sm,
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.sm,
        paddingBottom: Spacing.sm,
      }}
    >
      {actions.map((a) => {
        const bg = a.destructive ? c.danger + '22' : c.accentSubtle;
        const fg = a.destructive ? c.danger : c.accent;
        return (
          <Pressable
            key={a.label}
            disabled={busy}
            onPress={a.onPress}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: bg,
              paddingVertical: 11,
              borderRadius: Radii.md,
              opacity: pressed ? 0.6 : busy ? 0.5 : 1,
            })}
          >
            <Icon ios={a.icon.ios} android={a.icon.android} size={15} color={fg} />
            <Text style={{ ...Typography.subhead, color: fg, fontWeight: '600' }}>
              {a.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function OverviewBody({ obj, def }: { obj: K8sObject; def: ResourceDef }) {
  // Build a list of key/value rows derived from the object.
  const meta = obj.metadata;
  const status: any = obj.status ?? {};
  const spec: any = obj.spec ?? {};
  const rows: Array<[string, string]> = [];
  rows.push(['Name', meta.name]);
  if (meta.namespace) rows.push(['Namespace', meta.namespace]);
  rows.push(['Created', `${meta.creationTimestamp ?? '—'} (${age(meta.creationTimestamp)})`]);
  rows.push(['UID', meta.uid ?? '—']);
  if (status.phase) rows.push(['Phase', status.phase]);
  if (typeof spec.replicas === 'number')
    rows.push(['Replicas', `${status?.readyReplicas ?? 0} / ${spec.replicas}`]);
  if (def.kind === 'Pod') {
    rows.push(['Node', spec.nodeName ?? '—']);
    rows.push(['Pod IP', status.podIP ?? '—']);
  }
  if (def.kind === 'Service') {
    rows.push(['Type', spec.type ?? '—']);
    rows.push(['Cluster IP', spec.clusterIP ?? '—']);
    // Service ports get their own card (tappable chips) below — skipping
    // the plain text row keeps the metadata block tight.
  }

  return (
    <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
      {/* Inline actions hoisted to the screen-level ActionBar — see top of file. */}

      <SectionCard title="Metadata">
        {rows.map(([k, v], i) => (
          <KV key={i} k={k} v={v} />
        ))}
      </SectionCard>

      <OwnerReferencesCard obj={obj} />

      {meta.labels && Object.keys(meta.labels).length ? (
        <SectionCard title="Labels">
          <Chips items={Object.entries(meta.labels).map(([k, v]) => `${k}=${v}`)} />
        </SectionCard>
      ) : null}

      {def.kind === 'Pod' && meta.namespace ? (
        <MetricsRow kind="Pod" name={meta.name} namespace={meta.namespace} pod={obj} />
      ) : null}
      {def.kind === 'Node' ? <MetricsRow kind="Node" name={meta.name} node={obj} /> : null}

      {def.kind === 'Pod' ? <PodContainersCard obj={obj} /> : null}
      {def.kind === 'Pod' ? <PodVolumesCard obj={obj} /> : null}
      {def.kind === 'Pod' ? <PodSchedulingCard obj={obj} /> : null}
      {def.kind === 'Pod' ? <PodRuntimeCard obj={obj} /> : null}
      {def.kind === 'Service' ? <ServicePortsCard obj={obj} /> : null}
      {def.kind === 'ConfigMap' ? <DataCard data={obj.data ?? {}} /> : null}
      {def.kind === 'Secret' ? <DataCard data={obj.data ?? {}} secret /> : null}

      {status.conditions?.length ? (
        <SectionCard title="Conditions">
          {status.conditions.map((cnd: any, i: number) => (
            <KV
              key={i}
              k={cnd.type}
              v={`${cnd.status}${cnd.reason ? ` · ${cnd.reason}` : ''}${cnd.message ? ` — ${cnd.message}` : ''}`}
            />
          ))}
        </SectionCard>
      ) : null}
    </View>
  );
}

function PodContainersCard({ obj }: { obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const spec: any = obj.spec ?? {};
  const status: any = obj.status ?? {};
  const containers = [
    ...(spec.initContainers ?? []).map((cnt: any) => ({ ...cnt, _init: true })),
    ...(spec.containers ?? []),
  ];
  const statuses: Record<string, any> = {};
  for (const s of [
    ...(status.initContainerStatuses ?? []),
    ...(status.containerStatuses ?? []),
  ]) {
    statuses[s.name] = s;
  }
  // Per-container collapsed state. Default OPEN — most pods have one container
  // and the expanded body is the point of the page. Tap header to collapse.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <SectionCard title="Containers">
      {containers.map((cnt: any, i: number) => {
        const st = statuses[cnt.name];
        const state = st?.state?.running
          ? 'Running'
          : st?.state?.waiting?.reason ?? (st?.state?.terminated?.reason ?? '—');
        const stateColor =
          state === 'Running'
            ? c.success
            : state.includes('Back') || state.includes('Error')
            ? c.danger
            : c.warning;
        const isOpen = !collapsed[cnt.name];
        return (
          <View key={i} style={{ paddingVertical: 6, gap: 2 }}>
            <Pressable
              onPress={() => setCollapsed((cs) => ({ ...cs, [cnt.name]: isOpen }))}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, gap: 2 })}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stateColor }} />
                <Text style={{ ...Typography.headline, color: c.text, flex: 1 }}>
                  {cnt.name}
                  {cnt._init ? (
                    <Text style={{ color: c.textTertiary, ...Typography.caption1 }}> · init</Text>
                  ) : null}
                </Text>
                {st ? (
                  <Text style={{ ...Typography.footnote, color: c.textSecondary }}>
                    restarts {st.restartCount ?? 0}
                  </Text>
                ) : null}
                <Icon
                  ios={isOpen ? 'chevron.up' : 'chevron.down'}
                  android={isOpen ? 'expand_less' : 'expand_more'}
                  size={14}
                  color={c.textTertiary}
                />
              </View>
              <Text
                style={{
                  ...Typography.caption1,
                  color: c.textSecondary,
                  fontFamily: Typography.mono.fontFamily,
                }}
              >
                {cnt.image}
              </Text>
              <Text style={{ ...Typography.caption1, color: c.textTertiary }}>{state}</Text>
            </Pressable>
            {isOpen ? <ContainerExpandedDetails container={cnt} pod={obj} /> : null}
          </View>
        );
      })}
    </SectionCard>
  );
}

// ── Container expansion ────────────────────────────────────────────────────
// Renders the sub-sections that explain what the container actually sees at
// runtime: ports, resource quotas, env vars (with downward-API resolution
// and tappable Secret/ConfigMap refs), envFrom imports, volume mounts paired
// with their pod-level volume source, and probe one-liners.
function ContainerExpandedDetails({ container, pod }: { container: any; pod: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const env: any[] = container.env ?? [];
  const envFrom: any[] = container.envFrom ?? [];
  const mounts: any[] = container.volumeMounts ?? [];
  const ports: any[] = container.ports ?? [];
  const resources: any = container.resources ?? {};
  const hasResources = !!(resources.requests || resources.limits);
  const hasProbes = !!(
    container.livenessProbe ||
    container.readinessProbe ||
    container.startupProbe
  );
  const cmd: string[] = container.command ?? [];
  const args: string[] = container.args ?? [];

  return (
    <View
      style={{
        gap: Spacing.md,
        marginTop: Spacing.sm,
        paddingTop: Spacing.sm,
        borderTopWidth: 0.5,
        borderTopColor: c.separator,
      }}
    >
      {ports.length > 0 ? (
        <SubSection title="Ports">
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {ports.map((p, i) => (
              <PortChip key={i} port={p} pod={pod} />
            ))}
          </View>
        </SubSection>
      ) : null}

      {hasResources ? (
        <SubSection title="Resources">
          {resources.requests ? (
            <Text
              style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
            >
              <Text style={{ color: c.textSecondary }}>requests · </Text>
              {Object.entries(resources.requests as Record<string, string>)
                .map(([k, v]) => `${k}=${v}`)
                .join('   ')}
            </Text>
          ) : null}
          {resources.limits ? (
            <Text
              style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
            >
              <Text style={{ color: c.textSecondary }}>limits · </Text>
              {Object.entries(resources.limits as Record<string, string>)
                .map(([k, v]) => `${k}=${v}`)
                .join('   ')}
            </Text>
          ) : null}
        </SubSection>
      ) : null}

      {env.length > 0 || envFrom.length > 0 ? (
        <SubSection title="Environment">
          {env.map((e, i) => (
            <EnvVarRow key={`e${i}`} envVar={e} pod={pod} />
          ))}
          {envFrom.map((ef, i) => (
            <EnvFromRow key={`f${i}`} envFrom={ef} pod={pod} />
          ))}
        </SubSection>
      ) : null}

      {mounts.length > 0 ? (
        <SubSection title="Volume mounts">
          {mounts.map((m, i) => (
            <VolumeMountRow key={i} mount={m} pod={pod} />
          ))}
        </SubSection>
      ) : null}

      {hasProbes ? (
        <SubSection title="Probes">
          {container.livenessProbe ? (
            <ProbeLine label="liveness" text={probeToText(container.livenessProbe)} />
          ) : null}
          {container.readinessProbe ? (
            <ProbeLine label="readiness" text={probeToText(container.readinessProbe)} />
          ) : null}
          {container.startupProbe ? (
            <ProbeLine label="startup" text={probeToText(container.startupProbe)} />
          ) : null}
        </SubSection>
      ) : null}

      {cmd.length > 0 || args.length > 0 ? (
        <SubSection title="Command">
          {cmd.length > 0 ? (
            <Text
              style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
              selectable
            >
              {cmd.join(' ')}
            </Text>
          ) : null}
          {args.length > 0 ? (
            <Text
              style={{
                color: c.textSecondary,
                ...Typography.caption1,
                fontFamily: Typography.mono.fontFamily,
              }}
              selectable
            >
              {args.join(' ')}
            </Text>
          ) : null}
        </SubSection>
      ) : null}
    </View>
  );
}

function EnvVarRow({ envVar, pod }: { envVar: any; pod: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  const ns = pod.metadata.namespace;

  let value: React.ReactNode;
  if (envVar.value !== undefined) {
    value = (
      <Text
        style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
        selectable
      >
        {String(envVar.value)}
      </Text>
    );
  } else if (envVar.valueFrom?.configMapKeyRef) {
    const r = envVar.valueFrom.configMapKeyRef;
    value = (
      <RefLink onPress={() => navigate('ConfigMap', 'v1', r.name, ns)}>
        ← configmap/{r.name}:{r.key}
        {r.optional ? ' (optional)' : ''}
      </RefLink>
    );
  } else if (envVar.valueFrom?.secretKeyRef) {
    const r = envVar.valueFrom.secretKeyRef;
    value = (
      <RefLink onPress={() => navigate('Secret', 'v1', r.name, ns)}>
        ← secret/{r.name}:{r.key}
        {r.optional ? ' (optional)' : ''}
      </RefLink>
    );
  } else if (envVar.valueFrom?.fieldRef) {
    const fp = envVar.valueFrom.fieldRef.fieldPath;
    const resolved = resolveFieldPath(pod, fp);
    value = (
      <Text
        style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
        selectable
      >
        {resolved ?? '—'}
        <Text style={{ color: c.textTertiary }}>  ({fp})</Text>
      </Text>
    );
  } else if (envVar.valueFrom?.resourceFieldRef) {
    const rfr = envVar.valueFrom.resourceFieldRef;
    value = (
      <Text style={{ color: c.textSecondary, ...Typography.caption1, fontStyle: 'italic' }}>
        ← {rfr.resource}
        {rfr.containerName ? ` (container ${rfr.containerName})` : ''}
      </Text>
    );
  } else {
    value = <Text style={{ color: c.textTertiary, ...Typography.caption1 }}>—</Text>;
  }

  return (
    <View style={{ paddingVertical: 3 }}>
      <Text
        style={{
          color: c.textSecondary,
          ...Typography.caption2,
          fontFamily: Typography.mono.fontFamily,
        }}
      >
        {envVar.name}
      </Text>
      {value}
    </View>
  );
}

function EnvFromRow({ envFrom, pod }: { envFrom: any; pod: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  const ns = pod.metadata.namespace;
  const prefix = envFrom.prefix ? ` prefix=${envFrom.prefix}` : '';

  if (envFrom.configMapRef) {
    const r = envFrom.configMapRef;
    return (
      <View style={{ paddingVertical: 3 }}>
        <Text style={{ color: c.textSecondary, ...Typography.caption2 }}>envFrom</Text>
        <RefLink onPress={() => navigate('ConfigMap', 'v1', r.name, ns)}>
          all keys ← configmap/{r.name}
          {prefix}
          {r.optional ? ' (optional)' : ''}
        </RefLink>
      </View>
    );
  }
  if (envFrom.secretRef) {
    const r = envFrom.secretRef;
    return (
      <View style={{ paddingVertical: 3 }}>
        <Text style={{ color: c.textSecondary, ...Typography.caption2 }}>envFrom</Text>
        <RefLink onPress={() => navigate('Secret', 'v1', r.name, ns)}>
          all keys ← secret/{r.name}
          {prefix}
          {r.optional ? ' (optional)' : ''}
        </RefLink>
      </View>
    );
  }
  return null;
}

function VolumeMountRow({ mount, pod }: { mount: any; pod: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  // Look up the corresponding pod-level volume so the mount tells you both
  // *where* it lives in the container and *what* it actually is.
  const volumes: any[] = (pod.spec as any)?.volumes ?? [];
  const v = volumes.find((x) => x.name === mount.name);
  const source: VolumeSource | undefined = v ? identifyVolumeSource(v) : undefined;
  const ns = pod.metadata.namespace;

  return (
    <View style={{ paddingVertical: 3 }}>
      <Text
        style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
      >
        {mount.mountPath}
        {mount.subPath ? <Text style={{ color: c.textTertiary }}>  subPath={mount.subPath}</Text> : null}
        {mount.readOnly ? <Text style={{ color: c.textTertiary }}>  ro</Text> : null}
      </Text>
      {source?.ref ? (
        <RefLink
          onPress={() => navigate(source.ref!.kind, refApiVersion(source.ref!.kind), source.ref!.name, ns)}
        >
          ← {source.type}/{source.ref.name}
        </RefLink>
      ) : (
        <Text style={{ color: c.textTertiary, ...Typography.caption2 }}>
          ← {source?.type ?? mount.name}
          {source?.detail ? ` (${source.detail})` : ''}
        </Text>
      )}
    </View>
  );
}

// Service ports card. Each spec.ports entry is a chip; tapping resolves a
// backing pod via Endpoints and starts a Pod port-forward to that pod's
// targetPort (numeric or named-port-in-pod resolution).
function ServicePortsCard({ obj }: { obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const ports: any[] = (obj.spec as any)?.ports ?? [];
  if (ports.length === 0) return null;
  return (
    <SectionCard title={`Ports · ${ports.length}`}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
        {ports.map((p, i) => (
          <ServicePortChip key={i} port={p} service={obj} />
        ))}
      </View>
      <Text
        style={{
          ...Typography.caption2,
          color: c.textTertiary,
          marginTop: 8,
        }}
      >
        Tap a port to forward via the first ready endpoint.
      </Text>
    </SectionCard>
  );
}

function ServicePortChip({ port, service }: { port: any; service: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const startForward = useStartPortForward();
  const { client } = useClusters();
  const [resolving, setResolving] = useState(false);

  const portNum = Number(port.port);
  if (!portNum) return null;
  const protoSuffix =
    port.protocol && port.protocol !== 'TCP' ? `/${port.protocol}` : '';
  const targetSuffix =
    port.targetPort !== undefined && port.targetPort !== portNum
      ? `  →  ${port.targetPort}`
      : '';
  const label = [
    port.name ? port.name : null,
    `${portNum}${protoSuffix}${targetSuffix}`,
  ]
    .filter(Boolean)
    .join(' · ');

  async function onPress() {
    if (!client || resolving) return;
    const ns = service.metadata.namespace ?? 'default';
    const svcName = service.metadata.name;
    const epDef = BUILTIN_RESOURCES.find((r) => r.slug === 'endpoints');
    const podDef = BUILTIN_RESOURCES.find((r) => r.slug === 'pods');
    if (!epDef || !podDef) return;

    setResolving(true);
    try {
      // Resolve a backing pod for the service. We try two sources in order:
      //   1) the legacy core/v1 Endpoints object (still served by every K8s
      //      version we care about; the simplest "give me pods for this svc"
      //      API);
      //   2) discovery.k8s.io/v1 EndpointSlices, labelled
      //      kubernetes.io/service-name=<svcName>. This is the modern API and
      //      is the only one some 1.33+ configurations may keep populating.
      // We pick the first address that carries a targetRef.name — port-forward
      // needs a pod name, not just an IP.
      let chosen: { name: string; namespace?: string } | undefined;
      let readyCount = 0;        // addresses we saw with targetRef.name
      let ipOnlyCount = 0;       // addresses with no targetRef (manually-created Endpoints, headless edge cases)
      let notReadyCount = 0;     // notReadyAddresses we observed

      // ── Try Endpoints first ───────────────────────────────────────────
      let endpointsFound = false;
      try {
        const endpoints: any = await client.get(epDef, svcName, ns);
        endpointsFound = true;
        for (const subset of endpoints.subsets ?? []) {
          for (const addr of subset.addresses ?? []) {
            if (addr.targetRef?.name) {
              readyCount++;
              if (!chosen) {
                chosen = {
                  name: addr.targetRef.name,
                  namespace: addr.targetRef.namespace ?? ns,
                };
              }
            } else if (addr.ip) {
              ipOnlyCount++;
            }
          }
          notReadyCount += (subset.notReadyAddresses ?? []).length;
        }
      } catch (e: any) {
        // Most likely a 404 (Endpoints removed in K8s 1.33+, or the object
        // never existed for a freshly-created service). Fall through to
        // EndpointSlices — don't abort.
      }

      // ── Fallback: EndpointSlices ──────────────────────────────────────
      if (!chosen) {
        const sliceDef = {
          apiGroup: 'discovery.k8s.io',
          apiVersion: 'v1',
          plural: 'endpointslices',
          namespaced: true,
        };
        try {
          const slices: any = await client.list(sliceDef, {
            namespace: ns,
            labelSelector: `kubernetes.io/service-name=${svcName}`,
          });
          for (const slice of slices.items ?? []) {
            for (const ep of slice.endpoints ?? []) {
              // EndpointSlice marks ready=true/false/undefined per endpoint.
              // Treat undefined as ready (matches the K8s conformance default).
              const isReady = ep.conditions?.ready !== false;
              if (isReady && ep.targetRef?.name) {
                readyCount++;
                if (!chosen) {
                  chosen = {
                    name: ep.targetRef.name,
                    namespace: ep.targetRef.namespace ?? ns,
                  };
                }
              } else if (!ep.targetRef?.name && (ep.addresses ?? []).length > 0) {
                ipOnlyCount++;
              } else if (!isReady) {
                notReadyCount++;
              }
            }
          }
        } catch {
          // Cluster doesn't expose EndpointSlices; nothing more to try.
        }
      }

      if (!chosen) {
        const detail =
          readyCount === 0 && ipOnlyCount === 0 && notReadyCount === 0
            ? endpointsFound
              ? `Endpoints exists but lists no addresses. The service selector may not match any running pods.`
              : `Could not read Endpoints or EndpointSlices for ${svcName}. Check RBAC for the endpoints / endpointslices verbs.`
            : `${readyCount} ready, ${notReadyCount} not-ready, ${ipOnlyCount} address(es) without a pod targetRef. Port-forward needs a pod name.`;
        Alert.alert('Cannot resolve service endpoint', detail);
        return;
      }
      const podName = chosen.name;
      const podNs = chosen.namespace ?? ns;

      // Resolve targetPort. Numbers go straight through; named ports require
      // looking up the matching containerPort in the backing pod's spec.
      let remotePort: number;
      const tp = port.targetPort;
      if (typeof tp === 'number') {
        remotePort = tp;
      } else if (typeof tp === 'string' && tp.length > 0) {
        const pod: any = await client.get(podDef, podName, podNs);
        const containers: any[] = pod.spec?.containers ?? [];
        let found: number | undefined;
        outer: for (const cnt of containers) {
          for (const p of cnt.ports ?? []) {
            if (p.name === tp) {
              found = Number(p.containerPort);
              break outer;
            }
          }
        }
        if (!found) {
          Alert.alert(
            'Named port not found',
            `Pod ${podName} doesn't expose a port named "${tp}".`,
          );
          return;
        }
        remotePort = found;
      } else {
        // targetPort absent → defaults to the service port.
        remotePort = portNum;
      }

      await startForward({
        sourceKind: 'Service',
        sourceName: svcName,
        podName,
        namespace: podNs,
        remotePort,
      });
    } catch (e: any) {
      Alert.alert('Could not resolve service endpoint', e?.message ?? String(e));
    } finally {
      setResolving(false);
    }
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={resolving}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: pressed ? c.accent + '33' : c.accentSubtle,
        borderRadius: 999,
        opacity: resolving ? 0.5 : 1,
      })}
    >
      <Icon ios="arrow.left.arrow.right" android="swap_horiz" size={12} color={c.accent} />
      <Text
        style={{
          ...Typography.caption1,
          color: c.accent,
          fontFamily: Typography.mono.fontFamily,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Tappable port chip. Each pod container port becomes a small pill that
// kicks off a port-forward via the global PortForwardProvider; on success
// the user gets a "Open in Safari" prompt with the bound local URL.
function PortChip({
  port,
  pod,
  sourceKind = 'Pod',
  sourceName,
}: {
  port: any;
  pod: K8sObject;
  /** Override when the chip is rendered on a Service detail (svc → backing pod). */
  sourceKind?: 'Pod' | 'Service';
  /** Override when the source kind isn't Pod. */
  sourceName?: string;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const startForward = useStartPortForward();
  const portNum = Number(port.containerPort ?? port.port);
  if (!portNum || Number.isNaN(portNum)) return null;
  const label = [
    port.name ? port.name : null,
    `${portNum}${port.protocol && port.protocol !== 'TCP' ? `/${port.protocol}` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      onPress={() =>
        startForward({
          sourceKind,
          sourceName: sourceName ?? pod.metadata.name,
          podName: pod.metadata.name,
          namespace: pod.metadata.namespace ?? 'default',
          remotePort: portNum,
        })
      }
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: pressed ? c.accent + '33' : c.accentSubtle,
        borderRadius: 999,
      })}
    >
      <Icon ios="arrow.left.arrow.right" android="swap_horiz" size={12} color={c.accent} />
      <Text
        style={{
          ...Typography.caption1,
          color: c.accent,
          fontFamily: Typography.mono.fontFamily,
          fontWeight: '600',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function ProbeLine({ label, text }: { label: string; text: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Text
      style={{ color: c.text, ...Typography.caption1, fontFamily: Typography.mono.fontFamily }}
    >
      <Text style={{ color: c.textSecondary }}>{label} · </Text>
      {text}
    </Text>
  );
}

// ── Pod-level cards ────────────────────────────────────────────────────────
// One card each for the three big "where does this pod fit in the cluster"
// questions: which volumes does it consume, where does it get scheduled and
// under whose identity, and what runtime flags / security context apply.

function PodVolumesCard({ obj }: { obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  const volumes: any[] = (obj.spec as any)?.volumes ?? [];
  if (volumes.length === 0) return null;
  const ns = obj.metadata.namespace;

  return (
    <SectionCard title={`Volumes · ${volumes.length}`}>
      {volumes.map((v, i) => {
        const src = identifyVolumeSource(v);
        return (
          <View key={i} style={{ paddingVertical: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                style={{
                  ...Typography.subhead,
                  color: c.text,
                  fontWeight: '600',
                  flex: 1,
                  fontFamily: Typography.mono.fontFamily,
                }}
              >
                {v.name}
              </Text>
              <Text style={{ ...Typography.caption1, color: c.textTertiary }}>{src.type}</Text>
            </View>
            {src.ref ? (
              <RefLink
                onPress={() => navigate(src.ref!.kind, refApiVersion(src.ref!.kind), src.ref!.name, ns)}
              >
                {src.ref.kind.toLowerCase()}/{src.ref.name}
                {src.detail ? `  (${src.detail})` : ''}
              </RefLink>
            ) : src.detail ? (
              <Text
                style={{
                  ...Typography.caption1,
                  color: c.textSecondary,
                  fontFamily: Typography.mono.fontFamily,
                  marginTop: 2,
                }}
              >
                {src.detail}
              </Text>
            ) : null}
          </View>
        );
      })}
    </SectionCard>
  );
}

function PodSchedulingCard({ obj }: { obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  const spec: any = obj.spec ?? {};
  const ns = obj.metadata.namespace;

  const hasNodeSelector = spec.nodeSelector && Object.keys(spec.nodeSelector).length > 0;
  const tolerations: any[] = spec.tolerations ?? [];
  const pullSecrets: any[] = spec.imagePullSecrets ?? [];
  const sa = spec.serviceAccountName ?? spec.serviceAccount;

  if (
    !spec.nodeName &&
    !sa &&
    !spec.priorityClassName &&
    spec.priority === undefined &&
    !hasNodeSelector &&
    tolerations.length === 0 &&
    pullSecrets.length === 0
  ) {
    return null;
  }

  return (
    <SectionCard title="Scheduling">
      {spec.nodeName ? (
        <View style={{ paddingVertical: 4 }}>
          <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Node</Text>
          <RefLink onPress={() => navigate('Node', 'v1', spec.nodeName)}>
            {spec.nodeName}
          </RefLink>
        </View>
      ) : null}
      {sa ? (
        <View style={{ paddingVertical: 4 }}>
          <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Service account</Text>
          <RefLink onPress={() => navigate('ServiceAccount', 'v1', sa, ns)}>{sa}</RefLink>
        </View>
      ) : null}
      {spec.priorityClassName ? (
        <KV k="Priority class" v={spec.priorityClassName} />
      ) : null}
      {spec.priority !== undefined ? <KV k="Priority" v={String(spec.priority)} /> : null}
      {pullSecrets.length > 0 ? (
        <View style={{ paddingVertical: 4 }}>
          <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Image pull secrets</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            {pullSecrets.map((s, i) => (
              <RefLink key={i} onPress={() => navigate('Secret', 'v1', s.name, ns)}>
                {s.name}
              </RefLink>
            ))}
          </View>
        </View>
      ) : null}
      {hasNodeSelector ? (
        <View style={{ paddingVertical: 4 }}>
          <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Node selector</Text>
          <Chips
            items={Object.entries(spec.nodeSelector as Record<string, string>).map(
              ([k, v]) => `${k}=${v}`,
            )}
          />
        </View>
      ) : null}
      {tolerations.length > 0 ? (
        <View style={{ paddingVertical: 4 }}>
          <Text style={{ ...Typography.caption1, color: c.textSecondary }}>Tolerations</Text>
          {tolerations.map((t, i) => (
            <Text
              key={i}
              style={{
                color: c.text,
                ...Typography.caption1,
                fontFamily: Typography.mono.fontFamily,
              }}
            >
              {tolerationToText(t)}
            </Text>
          ))}
        </View>
      ) : null}
    </SectionCard>
  );
}

function PodRuntimeCard({ obj }: { obj: K8sObject }) {
  const spec: any = obj.spec ?? {};
  const status: any = obj.status ?? {};
  const sc = spec.securityContext ?? {};

  const rows: Array<[string, string]> = [];
  if (spec.restartPolicy) rows.push(['Restart policy', spec.restartPolicy]);
  if (spec.dnsPolicy) rows.push(['DNS policy', spec.dnsPolicy]);
  if (typeof spec.terminationGracePeriodSeconds === 'number') {
    rows.push(['Term. grace', `${spec.terminationGracePeriodSeconds}s`]);
  }
  if (status.qosClass) rows.push(['QoS class', status.qosClass]);
  if (status.hostIP) rows.push(['Host IP', status.hostIP]);
  if (spec.hostNetwork) rows.push(['Host network', 'true']);
  if (spec.hostPID) rows.push(['Host PID', 'true']);
  if (spec.hostIPC) rows.push(['Host IPC', 'true']);
  if (spec.shareProcessNamespace) rows.push(['Share PID ns', 'true']);
  if (sc.runAsUser !== undefined) rows.push(['runAsUser', String(sc.runAsUser)]);
  if (sc.runAsGroup !== undefined) rows.push(['runAsGroup', String(sc.runAsGroup)]);
  if (sc.runAsNonRoot !== undefined) rows.push(['runAsNonRoot', String(sc.runAsNonRoot)]);
  if (sc.fsGroup !== undefined) rows.push(['fsGroup', String(sc.fsGroup)]);

  if (rows.length === 0) return null;

  return (
    <SectionCard title="Runtime">
      {rows.map(([k, v], i) => (
        <KV key={i} k={k} v={v} />
      ))}
    </SectionCard>
  );
}

// ── Building blocks shared by the pod cards ────────────────────────────────

function SubSection({ title, children }: { title: string; children: React.ReactNode }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View style={{ gap: 2 }}>
      <Text
        style={{
          ...Typography.caption2,
          color: c.textTertiary,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 2,
        }}
      >
        {title}
      </Text>
      {children}
    </View>
  );
}

function RefLink({
  onPress,
  children,
}: {
  onPress: () => void;
  children: React.ReactNode;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Pressable onPress={onPress} hitSlop={6}>
      <Text
        style={{
          color: c.accent,
          ...Typography.caption1,
          fontFamily: Typography.mono.fontFamily,
        }}
      >
        {children}
      </Text>
    </Pressable>
  );
}

// Hook form: resolves built-ins and CRDs (via the cluster context) and
// routes to the correct detail screen, honouring namespace-scope. Used by
// every cross-resource link on the detail page — env refs, volume sources,
// scheduling refs, owner references.
function useNavigateToResource() {
  const router = useRouter();
  const { crds } = useCRDs();
  return useCallback(
    (kind: string, apiVersion: string, name: string, namespace?: string) => {
      const group = apiGroupFromVersion(apiVersion);
      const def = findResourceByKindGroup(kind, group, crds);
      if (!def) return;
      const nsPart =
        namespace && def.namespaced ? `?namespace=${encodeURIComponent(namespace)}` : '';
      router.push(`/(app)/(stack)/r/${def.slug}/${encodeURIComponent(name)}${nsPart}` as any);
    },
    [router, crds],
  );
}

// The volume-source / pod-spec references don't carry an apiVersion; everything
// the pod can reference natively (ConfigMap, Secret, PVC, ServiceAccount, Node)
// is in the core "v1" group, so default there.
function refApiVersion(_kind: string): string {
  return 'v1';
}

// Generic owner-references card. Reads metadata.ownerReferences and turns each
// entry into a tappable link via the kind+apiVersion-aware navigate hook.
// Works for any resource kind — that's how you get the Pod → ReplicaSet →
// Deployment chain by tapping through.
function OwnerReferencesCard({ obj }: { obj: K8sObject }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const navigate = useNavigateToResource();
  const refs = obj.metadata.ownerReferences ?? [];
  if (refs.length === 0) return null;
  // Owner refs always live in the same namespace as the owned object.
  const ns = obj.metadata.namespace;

  return (
    <SectionCard title="Owner references">
      {refs.map((r, i) => (
        <View
          key={i}
          style={{
            paddingVertical: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Text
            style={{
              ...Typography.caption1,
              color: c.textSecondary,
              minWidth: 90,
            }}
          >
            {r.kind}
          </Text>
          <View style={{ flex: 1 }}>
            <RefLink onPress={() => navigate(r.kind, r.apiVersion, r.name, ns)}>
              {r.name}
            </RefLink>
          </View>
          {r.controller ? (
            <Text style={{ color: c.textTertiary, ...Typography.caption2 }}>controller</Text>
          ) : null}
        </View>
      ))}
    </SectionCard>
  );
}

function DataCard({ data, secret }: { data: Record<string, string>; secret?: boolean }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const keys = Object.keys(data);
  // Per-row reveal toggles for secrets. Map<key, revealed>.
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  return (
    <SectionCard title={`Data · ${keys.length}`}>
      {keys.map((k) => {
        const raw = data[k] ?? '';
        // Secret values arrive base64-encoded; decode for display but fall back
        // to the raw string for binary-looking values (e.g. helm release blobs).
        let display = raw;
        let binary = false;
        if (secret) {
          try {
            const bin = globalThis.atob(raw);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            display = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            binary = true;
            display = '[binary]';
          }
        }
        const isRevealed = !secret || revealed[k];
        return (
          <View key={k} style={{ paddingVertical: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                style={{ ...Typography.subhead, color: c.text, fontWeight: '600', flex: 1 }}
              >
                {k}
              </Text>
              {secret && !binary ? (
                <Pressable
                  hitSlop={10}
                  onPress={() => setRevealed((r) => ({ ...r, [k]: !r[k] }))}
                >
                  <Icon
                    ios={isRevealed ? 'eye.slash' : 'eye'}
                    android={isRevealed ? 'visibility_off' : 'visibility'}
                    size={16}
                    color={c.textSecondary}
                  />
                </Pressable>
              ) : null}
            </View>
            <Text
              selectable={isRevealed && !binary}
              style={{
                ...Typography.caption1,
                color: binary ? c.textTertiary : c.textSecondary,
                fontFamily: Typography.mono.fontFamily,
                fontStyle: binary ? 'italic' : 'normal',
                marginTop: 2,
                letterSpacing: !isRevealed ? 2 : 0,
              }}
              numberOfLines={!isRevealed ? 1 : 6}
            >
              {!isRevealed ? '••••••••••••' : display}
            </Text>
          </View>
        );
      })}
      {keys.length === 0 ? (
        <Text style={{ ...Typography.caption1, color: c.textTertiary, fontStyle: 'italic' }}>
          No data.
        </Text>
      ) : null}
    </SectionCard>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View>
      <Text
        style={{
          ...Typography.footnote,
          color: c.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: 0.7,
          marginBottom: 6,
          paddingHorizontal: 4,
        }}
      >
        {title}
      </Text>
      <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
        {children}
      </Glass>
    </View>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View style={{ paddingVertical: 4 }}>
      <Text style={{ ...Typography.caption1, color: c.textSecondary }}>{k}</Text>
      <Text
        style={{
          ...Typography.subhead,
          color: c.text,
          fontFamily: k === 'UID' ? Typography.mono.fontFamily : undefined,
        }}
        selectable
      >
        {v}
      </Text>
    </View>
  );
}

function Chips({ items }: { items: string[] }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
      {items.map((i) => (
        <View
          key={i}
          style={{
            paddingHorizontal: 8,
            paddingVertical: 3,
            backgroundColor: c.surfaceMuted,
            borderRadius: 6,
          }}
        >
          <Text style={{ ...Typography.caption1, color: c.text, fontFamily: Typography.mono.fontFamily }}>{i}</Text>
        </View>
      ))}
    </View>
  );
}

function YamlBody({ text }: { text: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View style={{ padding: Spacing.lg }}>
      <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
        <Text selectable style={{ fontFamily: Typography.mono.fontFamily, fontSize: 12, color: c.text }}>
          {text}
        </Text>
      </Glass>
    </View>
  );
}
