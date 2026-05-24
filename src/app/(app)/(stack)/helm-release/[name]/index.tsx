import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { useClusters } from '@/lib/state/cluster-context';
import { getReleaseHistory, type HelmRelease } from '@/lib/k8s/helm';
import { toYaml } from '@/lib/util/yaml';
import { age } from '@/lib/util/time';

type Tab = 'overview' | 'values' | 'manifest' | 'history' | 'notes';

export default function HelmReleaseDetail() {
  const scheme = useScheme();
  const c = Colors[scheme];
  // namespace is a query param (the URL is /helm/<name>?namespace=<ns>),
  // matching the resource-detail screen at /r/<slug>/<name>?namespace=<ns>.
  // The earlier nested /helm/<ns>/<name>/ path was triggering a drawer-
  // routing glitch on phones — the drawer would stay open after navigating
  // into a release. Flattening to a single dynamic segment fixes it and is
  // more consistent with the rest of the app anyway.
  const { namespace, name } = useLocalSearchParams<{ namespace: string; name: string }>();
  const { client } = useClusters();

  const [history, setHistory] = useState<HelmRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  const load = useCallback(async () => {
    if (!client || !namespace || !name) return;
    setLoading(true);
    setError(null);
    try {
      const h = await getReleaseHistory(client, namespace, name);
      setHistory(h);
      // Default to the latest revision.
      if (h.length > 0 && selectedVersion == null) {
        setSelectedVersion(h[h.length - 1].version);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [client, namespace, name, selectedVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  const active: HelmRelease | undefined = useMemo(() => {
    if (selectedVersion == null) return history[history.length - 1];
    return history.find((r) => r.version === selectedVersion) ?? history[history.length - 1];
  }, [history, selectedVersion]);

  // Toggle whether the Values tab shows user-supplied config or merged with
  // the chart's defaults — Lens calls this "User-supplied values" vs
  // "Combined values".
  const [showDefaults, setShowDefaults] = useState(false);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: name ?? 'Release',
          headerBackTitle: 'Helm',
        }}
      />

      {loading && !active ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.accent} />
        </View>
      ) : error ? (
        <View style={{ padding: Spacing.lg }}>
          <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
            <Text style={{ color: c.danger, ...Typography.subhead }}>{error}</Text>
          </Glass>
        </View>
      ) : !active ? (
        <View style={{ padding: Spacing.lg }}>
          <Text style={{ color: c.textSecondary, ...Typography.subhead }}>Release not found.</Text>
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          stickyHeaderIndices={[1]}
          contentContainerStyle={{ paddingBottom: 60 }}
        >
          {/* 0: header */}
          <ReleaseHeader release={active} />

          {/* 1: sticky tab switcher */}
          <View
            style={{
              backgroundColor: c.background,
              paddingHorizontal: Spacing.lg,
              paddingTop: Spacing.xs,
              paddingBottom: Spacing.sm,
            }}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 6 }}
            >
              {(['overview', 'values', 'manifest', 'history', 'notes'] as Tab[]).map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTab(t)}
                  style={{
                    paddingVertical: 7,
                    paddingHorizontal: 14,
                    borderRadius: Radii.sm,
                    backgroundColor: tab === t ? c.accentSubtle : c.surfaceMuted,
                  }}
                >
                  <Text
                    style={{
                      ...Typography.subhead,
                      color: tab === t ? c.accent : c.textSecondary,
                      fontWeight: '600',
                      textTransform: 'capitalize',
                    }}
                  >
                    {t}
                    {t === 'history' ? ` · ${history.length}` : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {/* 2: tab body */}
          <View style={{ padding: Spacing.lg, gap: Spacing.md }}>
            {tab === 'overview' ? (
              <Overview release={active} />
            ) : tab === 'values' ? (
              <ValuesTab
                release={active}
                showDefaults={showDefaults}
                onToggle={() => setShowDefaults((v) => !v)}
              />
            ) : tab === 'manifest' ? (
              <YamlBlock title="Rendered manifest" text={active.manifest || '(empty)'} />
            ) : tab === 'history' ? (
              <History
                history={history}
                selected={active.version}
                onSelect={setSelectedVersion}
              />
            ) : (
              <NotesTab release={active} />
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function ReleaseHeader({ release }: { release: HelmRelease }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <View
      style={{
        paddingHorizontal: Spacing.lg,
        paddingTop: Spacing.sm,
        paddingBottom: 2,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: statusColor(release.status, c),
          }}
        />
        <Text
          style={{
            ...Typography.subhead,
            color: c.text,
            fontWeight: '600',
            textTransform: 'capitalize',
          }}
        >
          {release.status}
        </Text>
        <Text style={{ ...Typography.footnote, color: c.textSecondary }}>
          · {release.namespace} · rev {release.version}
          {release.lastDeployed ? ` · ${age(release.lastDeployed)}` : ''}
        </Text>
      </View>
      <Text
        style={{
          ...Typography.footnote,
          color: c.textSecondary,
          fontFamily: Typography.mono.fontFamily,
        }}
      >
        {release.chart.name}-{release.chart.version}
        {release.chart.appVersion ? `  ·  app ${release.chart.appVersion}` : ''}
      </Text>
    </View>
  );
}

function Overview({ release }: { release: HelmRelease }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const rows: Array<[string, string]> = [];
  rows.push(['Chart', `${release.chart.name} · ${release.chart.version}`]);
  if (release.chart.appVersion) rows.push(['App version', release.chart.appVersion]);
  rows.push(['Revision', String(release.version)]);
  rows.push(['Namespace', release.namespace]);
  rows.push(['Status', release.status]);
  if (release.firstDeployed)
    rows.push(['First deployed', `${release.firstDeployed} (${age(release.firstDeployed)})`]);
  if (release.lastDeployed)
    rows.push(['Last deployed', `${release.lastDeployed} (${age(release.lastDeployed)})`]);
  if (release.description) rows.push(['Description', release.description]);

  return (
    <>
      <SectionCard title="Release">
        {rows.map(([k, v], i) => (
          <KV key={i} k={k} v={v} />
        ))}
      </SectionCard>

      {release.chart.description ? (
        <SectionCard title="Chart description">
          <Text style={{ ...Typography.subhead, color: c.text }}>
            {release.chart.description}
          </Text>
        </SectionCard>
      ) : null}

      {(release.chart.home || (release.chart.sources?.length ?? 0) > 0 || (release.chart.keywords?.length ?? 0) > 0) ? (
        <SectionCard title="Chart links">
          {release.chart.home ? <KV k="Home" v={release.chart.home} /> : null}
          {(release.chart.sources ?? []).map((s, i) => (
            <KV key={i} k={i === 0 ? 'Sources' : ''} v={s} />
          ))}
          {(release.chart.keywords ?? []).length > 0 ? (
            <KV k="Keywords" v={(release.chart.keywords ?? []).join(', ')} />
          ) : null}
        </SectionCard>
      ) : null}
    </>
  );
}

function ValuesTab({
  release,
  showDefaults,
  onToggle,
}: {
  release: HelmRelease;
  showDefaults: boolean;
  onToggle: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const yaml = showDefaults
    ? toYaml(mergeDeep(release.defaultValues ?? {}, release.values))
    : toYaml(release.values);
  return (
    <>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => ({
          paddingVertical: 8,
          paddingHorizontal: 12,
          backgroundColor: pressed ? c.surfaceMuted : c.accentSubtle,
          borderRadius: Radii.md,
          alignSelf: 'flex-start',
        })}
      >
        <Text style={{ ...Typography.subhead, color: c.accent, fontWeight: '600' }}>
          {showDefaults ? 'Showing combined (defaults + user)' : 'Showing user-supplied only'} · tap to toggle
        </Text>
      </Pressable>
      <YamlBlock title={showDefaults ? 'Combined values' : 'User-supplied values'} text={yaml} />
    </>
  );
}

function NotesTab({ release }: { release: HelmRelease }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  if (!release.notes) {
    return (
      <Text style={{ color: c.textSecondary, ...Typography.subhead }}>
        This release has no chart NOTES.txt.
      </Text>
    );
  }
  return (
    <Glass radius={Radii.lg} style={{ padding: Spacing.md }}>
      <Text
        selectable
        style={{
          color: c.text,
          fontFamily: Typography.mono.fontFamily,
          fontSize: 12,
        }}
      >
        {release.notes}
      </Text>
    </Glass>
  );
}

function History({
  history,
  selected,
  onSelect,
}: {
  history: HelmRelease[];
  selected: number;
  onSelect: (v: number) => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];
  // Newest first.
  const sorted = [...history].sort((a, b) => b.version - a.version);
  return (
    <>
      {sorted.map((rev) => {
        const isSelected = rev.version === selected;
        const dot = statusColor(rev.status, c);
        return (
          <Pressable
            key={rev.version}
            onPress={() => onSelect(rev.version)}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <Glass
              radius={Radii.lg}
              style={{
                padding: Spacing.md,
                gap: 2,
                borderWidth: isSelected ? 1.5 : 0,
                borderColor: c.accent,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
                <Text style={{ ...Typography.headline, color: c.text, flex: 1 }}>
                  Revision {rev.version}
                </Text>
                <Text style={{ ...Typography.caption1, color: c.textTertiary }}>
                  {rev.lastDeployed ? age(rev.lastDeployed) : ''}
                </Text>
              </View>
              <Text
                style={{
                  ...Typography.caption1,
                  color: c.textSecondary,
                  fontFamily: Typography.mono.fontFamily,
                }}
              >
                {rev.chart.name}-{rev.chart.version}
                {rev.chart.appVersion ? ` · app ${rev.chart.appVersion}` : ''}
              </Text>
              <Text style={{ ...Typography.caption1, color: dot, fontWeight: '600', textTransform: 'capitalize' }}>
                {rev.status}
                {rev.description ? ` · ${rev.description}` : ''}
              </Text>
            </Glass>
          </Pressable>
        );
      })}
    </>
  );
}

function YamlBlock({ title, text }: { title: string; text: string }) {
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
        <Text
          selectable
          style={{
            color: c.text,
            fontFamily: Typography.mono.fontFamily,
            fontSize: 12,
          }}
        >
          {text}
        </Text>
      </Glass>
    </View>
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
      <Text style={{ ...Typography.subhead, color: c.text }} selectable>
        {v}
      </Text>
    </View>
  );
}

// Same status palette as the list screen.
type StatusPalette = {
  success: string;
  danger: string;
  warning: string;
  info: string;
  textTertiary: string;
};
function statusColor(status: string, c: StatusPalette): string {
  switch (status) {
    case 'deployed':
      return c.success;
    case 'failed':
    case 'pending-rollback':
      return c.danger;
    case 'uninstalled':
    case 'uninstalling':
    case 'superseded':
      return c.textTertiary;
    case 'pending-install':
    case 'pending-upgrade':
      return c.warning;
    default:
      return c.info;
  }
}

/** Plain deep-merge that overlays `b` onto `a`. Used to show "combined"
 *  values in the Values tab — chart defaults plus user-supplied config. */
function mergeDeep(a: any, b: any): any {
  if (b === null || b === undefined) return a;
  if (a === null || a === undefined) return b;
  if (typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) {
    return b;
  }
  const out: Record<string, any> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = mergeDeep((a as Record<string, any>)[k], v);
  }
  return out;
}
