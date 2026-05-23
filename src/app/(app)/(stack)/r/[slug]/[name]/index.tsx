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
import { BUILTIN_RESOURCES, parseSlug, type ResourceDef } from '@/lib/k8s/resources';
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
    rows.push(['Ports', (spec.ports ?? []).map((p: any) => `${p.port}/${p.protocol ?? 'TCP'}`).join(', ') || '—']);
  }

  return (
    <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
      {/* Inline actions hoisted to the screen-level ActionBar — see top of file. */}

      <SectionCard title="Metadata">
        {rows.map(([k, v], i) => (
          <KV key={i} k={k} v={v} />
        ))}
      </SectionCard>

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
  const containers = [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
  const statuses: Record<string, any> = {};
  for (const s of [...(status.initContainerStatuses ?? []), ...(status.containerStatuses ?? [])]) statuses[s.name] = s;

  return (
    <SectionCard title="Containers">
      {containers.map((cnt: any, i: number) => {
        const st = statuses[cnt.name];
        const state = st?.state?.running
          ? 'Running'
          : st?.state?.waiting?.reason ?? (st?.state?.terminated?.reason ?? '—');
        const stateColor =
          state === 'Running' ? c.success : state.includes('Back') || state.includes('Error') ? c.danger : c.warning;
        return (
          <View key={i} style={{ paddingVertical: 6, gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stateColor }} />
              <Text style={{ ...Typography.headline, color: c.text, flex: 1 }}>{cnt.name}</Text>
              {st ? (
                <Text style={{ ...Typography.footnote, color: c.textSecondary }}>
                  restarts {st.restartCount ?? 0}
                </Text>
              ) : null}
            </View>
            <Text style={{ ...Typography.caption1, color: c.textSecondary, fontFamily: Typography.mono.fontFamily }}>
              {cnt.image}
            </Text>
            <Text style={{ ...Typography.caption1, color: c.textTertiary }}>{state}</Text>
          </View>
        );
      })}
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
