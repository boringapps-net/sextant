import React, { useMemo, useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  
  useWindowDimensions,
} from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useClusters } from '@/lib/state/cluster-context';
import { useCRDs } from '@/lib/state/crds-context';
import { usePortForwards } from '@/lib/state/port-forward-context';
import { BUILTIN_RESOURCES, RESOURCE_CATEGORIES, type ResourceDef } from '@/lib/k8s/resources';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';

export function DrawerContent(props: any) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  // usePathname returns the URL without route groups, e.g. "/r/pods" or "/clusters".
  // Reliable for active-item detection; useSegments returns *template* names.
  const pathname = usePathname();
  const { active, clusters, activate, activeNamespace } = useClusters();
  const { crds, loading: crdsLoading } = useCRDs();
  const { forwards } = usePortForwards();
  const activeForwards = forwards.filter(
    (f) => f.status === 'listening' || f.status === 'starting',
  ).length;
  const [search, setSearch] = useState('');
  // Track which CRD domains are expanded. Defaults to all collapsed; opening one persists for the session.
  const [openDomains, setOpenDomains] = useState<Set<string>>(new Set());
  const toggleDomain = (d: string) =>
    setOpenDomains((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  const dims = useWindowDimensions();
  // Match (app)/_layout.tsx so the close-on-tap behaviour mirrors the drawer type.
  const isIPad =
    Platform.OS === 'ios' &&
    ((Platform as any).isPad === true ||
      Math.min(dims.width, dims.height) >= 768);
  const tablet = isIPad || Math.min(dims.width, dims.height) >= 600;

  // Strip route groups like "(app)/(stack)/" from a target path so we can
  // compare it against `pathname` (which never includes groups).
  const normalize = (p: string) => p.replace(/\/\([^/]+\)/g, '') || '/';

  // The resource slug embedded in the current URL, if any. usePathname gives
  // us resolved values; we just split on "/r/<slug>".
  const activeSlug = useMemo(() => {
    const m = /^\/r\/([^/?#]+)/.exec(pathname);
    return m ? decodeURIComponent(m[1]) : undefined;
  }, [pathname]);

  const allResources = useMemo<ResourceDef[]>(
    () => [...BUILTIN_RESOURCES, ...crds],
    [crds],
  );
  const filtered = useMemo(() => {
    if (!search.trim()) return allResources;
    const q = search.toLowerCase();
    return allResources.filter(
      (r) =>
        r.kind.toLowerCase().includes(q) ||
        r.plural.toLowerCase().includes(q) ||
        r.apiGroup.toLowerCase().includes(q),
    );
  }, [allResources, search]);

  function go(path: string) {
    const target = normalize(path);
    // Idempotency: avoid pushing a duplicate when the user taps the same
    // drawer item again. expo-router #33049 makes replace() unreliable through
    // nested route groups, so we just no-op when we're already there.
    if (pathname === target || pathname.startsWith(target + '/')) {
      if (!tablet) props.navigation?.closeDrawer?.();
      return;
    }
    // Close the drawer BEFORE navigating. Doing it the other way around
    // (replace first, then closeDrawer) was eating the close for some
    // routes — the navigation triggered an unmount that dropped the
    // queued close action before it ran.
    if (!tablet) props.navigation?.closeDrawer?.();
    router.replace(path as any);
  }

  // A single resource row. Used for built-ins directly and as the contents of
  // a CRD domain group.
  function renderRow(r: ResourceDef, indent = false) {
    const focused = activeSlug === r.slug;
    return (
      <Pressable
        key={r.slug}
        onPress={() => go(`/(app)/(stack)/r/${r.slug}`)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: Spacing.md,
          paddingLeft: indent ? Spacing.md + Spacing.sm : Spacing.sm,
          paddingRight: Spacing.sm,
          paddingVertical: 8,
          borderRadius: Radii.md,
          backgroundColor: focused
            ? c.accentSubtle
            : pressed
            ? c.surfaceMuted
            : 'transparent',
        })}
      >
        <Icon
          ios={r.icon.ios}
          android={r.icon.android}
          size={indent ? 16 : 18}
          color={focused ? c.accent : c.textSecondary}
        />
        <Text
          style={{
            ...Typography.callout,
            color: focused ? c.accent : c.text,
            fontWeight: focused ? '600' : '400',
            flex: 1,
          }}
          numberOfLines={1}
        >
          {r.kind}
        </Text>
      </Pressable>
    );
  }

  // Group CRDs by apiGroup ("domain"), render each as a collapsible section.
  // While a search is active, force every group open so matches stay visible.
  function renderGroupedCRDs(items: ResourceDef[]) {
    const grouped = new Map<string, ResourceDef[]>();
    for (const r of items) {
      const key = r.apiGroup || '(core)';
      const list = grouped.get(key);
      if (list) list.push(r);
      else grouped.set(key, [r]);
    }
    const domains = Array.from(grouped.keys()).sort();
    const searching = search.trim().length > 0;

    return domains.map((domain) => {
      const rows = grouped.get(domain)!;
      const expanded = searching || openDomains.has(domain);
      return (
        <View key={domain} style={{ marginBottom: 2 }}>
          <Pressable
            onPress={() => toggleDomain(domain)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: Spacing.sm,
              paddingVertical: 6,
              borderRadius: Radii.sm,
              backgroundColor: pressed ? c.surfaceMuted : 'transparent',
            })}
          >
            <Icon
              ios={expanded ? 'chevron.down' : 'chevron.right'}
              android={expanded ? 'expand_more' : 'chevron_right'}
              size={12}
              color={c.textTertiary}
            />
            <Text
              style={{
                ...Typography.footnote,
                color: c.textSecondary,
                fontFamily: Typography.mono.fontFamily,
                flex: 1,
              }}
              numberOfLines={1}
            >
              {domain}
            </Text>
            <Text style={{ ...Typography.caption2, color: c.textTertiary }}>
              {rows.length}
            </Text>
          </Pressable>
          {expanded ? rows.map((r) => renderRow(r, true)) : null}
        </View>
      );
    });
  }

  return (
    <SafeAreaView
      edges={['top', 'left']}
      style={{ flex: 1, backgroundColor: c.background }}
    >
    <ScrollView
      contentContainerStyle={{ paddingTop: Platform.OS === 'ios' ? 8 : 16, paddingBottom: 32 }}
      style={{ backgroundColor: c.background }}
    >
      {/* Cluster header */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md }}>
        <Glass radius={Radii.xl} style={{ padding: Spacing.md }}>
          <Pressable
            onPress={() => go('/(app)/(stack)/clusters')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: Spacing.md,
              opacity: pressed ? 0.7 : 1,
              borderRadius: Radii.md,
              backgroundColor: pathname === '/clusters' ? c.accentSubtle : 'transparent',
              padding: pathname === '/clusters' ? 4 : 0,
              margin: pathname === '/clusters' ? -4 : 0,
            })}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: c.accentSubtle,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon ios="server.rack" android="dns" size={20} color={c.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{ ...Typography.headline, color: c.text }}
              >
                {active?.name ?? 'No cluster selected'}
              </Text>
              <Text
                numberOfLines={1}
                style={{ ...Typography.caption1, color: c.textSecondary, marginTop: 1 }}
              >
                {active ? active.server.replace(/^https?:\/\//, '') : 'Tap to add'}
              </Text>
            </View>
            <Icon ios="chevron.up.chevron.down" android="unfold_more" size={16} color={c.textSecondary} />
          </Pressable>

          {/* Namespace pill */}
          {active ? (
            <Pressable
              onPress={() => go('/(app)/(stack)/namespace-picker')}
              style={{
                marginTop: Spacing.md,
                paddingVertical: 8,
                paddingHorizontal: 12,
                borderRadius: Radii.pill,
                backgroundColor:
                  pathname === '/namespace-picker' ? c.accentSubtle : c.surfaceMuted,
                flexDirection: 'row',
                alignItems: 'center',
                alignSelf: 'flex-start',
                gap: 6,
              }}
            >
              <Icon
                ios="folder"
                android="folder"
                size={13}
                color={pathname === '/namespace-picker' ? c.accent : c.textSecondary}
              />
              <Text
                style={{
                  ...Typography.footnote,
                  color: pathname === '/namespace-picker' ? c.accent : c.text,
                  fontWeight: '600',
                }}
              >
                {activeNamespace ?? 'All namespaces'}
              </Text>
              <Icon
                ios="chevron.down"
                android="expand_more"
                size={12}
                color={pathname === '/namespace-picker' ? c.accent : c.textSecondary}
              />
            </Pressable>
          ) : null}
        </Glass>
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: Spacing.lg, marginBottom: Spacing.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: c.surfaceMuted,
            borderRadius: Radii.md,
            paddingHorizontal: 10,
            height: 36,
            gap: 6,
          }}
        >
          <Icon ios="magnifyingglass" android="search" size={15} color={c.textSecondary} />
          <SearchInput value={search} onChange={setSearch} placeholderColor={c.textTertiary} textColor={c.text} />
        </View>
      </View>

      {/* Categorised resources */}
      <View>
        {RESOURCE_CATEGORIES.map((cat) => {
          const items = filtered.filter((r) => r.category === cat);
          if (items.length === 0) return null;
          return (
            <View key={cat} style={{ paddingHorizontal: Spacing.md, marginTop: Spacing.md }}>
              <Text
                style={{
                  ...Typography.footnote,
                  color: c.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  fontWeight: '600',
                  paddingHorizontal: Spacing.sm,
                  paddingBottom: 4,
                }}
              >
                {cat}
                {cat === 'Custom' && crdsLoading ? ' …' : ''}
              </Text>
              {cat === 'Custom'
                ? renderGroupedCRDs(items)
                : items.map((r) => renderRow(r))}
            </View>
          );
        })}

        {/* Tools — non-resource utilities like port forwards live here. */}
        <View style={{ paddingHorizontal: Spacing.md, marginTop: Spacing.md }}>
          <Text
            style={{
              ...Typography.footnote,
              color: c.textSecondary,
              textTransform: 'uppercase',
              letterSpacing: 1,
              fontWeight: '600',
              paddingHorizontal: Spacing.sm,
              paddingBottom: 4,
            }}
          >
            Tools
          </Text>
          {(() => {
            const focused = pathname === '/port-forwards';
            return (
              <Pressable
                onPress={() => go('/(app)/(stack)/port-forwards')}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: Spacing.md,
                  paddingLeft: Spacing.sm,
                  paddingRight: Spacing.sm,
                  paddingVertical: 8,
                  borderRadius: Radii.md,
                  backgroundColor: focused
                    ? c.accentSubtle
                    : pressed
                    ? c.surfaceMuted
                    : 'transparent',
                })}
              >
                <Icon
                  ios="arrow.left.arrow.right"
                  android="swap_horiz"
                  size={18}
                  color={focused ? c.accent : c.textSecondary}
                />
                <Text
                  style={{
                    ...Typography.callout,
                    color: focused ? c.accent : c.text,
                    fontWeight: focused ? '600' : '400',
                    flex: 1,
                  }}
                  numberOfLines={1}
                >
                  Port forwards
                </Text>
                {activeForwards > 0 ? (
                  <View
                    style={{
                      backgroundColor: c.accent,
                      paddingHorizontal: 6,
                      borderRadius: 8,
                      minWidth: 18,
                      height: 18,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text
                      style={{
                        ...Typography.caption2,
                        color: '#fff',
                        fontWeight: '700',
                      }}
                    >
                      {activeForwards}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })()}
          {(() => {
            const focused = pathname.startsWith('/helm');
            return (
              <Pressable
                onPress={() => go('/(app)/(stack)/helm')}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: Spacing.md,
                  paddingLeft: Spacing.sm,
                  paddingRight: Spacing.sm,
                  paddingVertical: 8,
                  borderRadius: Radii.md,
                  backgroundColor: focused
                    ? c.accentSubtle
                    : pressed
                    ? c.surfaceMuted
                    : 'transparent',
                })}
              >
                <Icon
                  ios="shippingbox"
                  android="inventory_2"
                  size={18}
                  color={focused ? c.accent : c.textSecondary}
                />
                <Text
                  style={{
                    ...Typography.callout,
                    color: focused ? c.accent : c.text,
                    fontWeight: focused ? '600' : '400',
                    flex: 1,
                  }}
                  numberOfLines={1}
                >
                  Helm releases
                </Text>
              </Pressable>
            );
          })()}
        </View>

        {clusters.length > 1 ? (
          <View style={{ paddingHorizontal: Spacing.md, marginTop: Spacing.xl }}>
            <Text
              style={{
                ...Typography.footnote,
                color: c.textSecondary,
                textTransform: 'uppercase',
                letterSpacing: 1,
                paddingHorizontal: Spacing.sm,
                paddingBottom: 4,
              }}
            >
              Switch cluster
            </Text>
            {clusters.map((cluster) => (
              <Pressable
                key={cluster.id}
                onPress={() => activate(cluster.id)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: Spacing.md,
                  paddingHorizontal: Spacing.sm,
                  paddingVertical: 9,
                  borderRadius: Radii.md,
                  backgroundColor: pressed ? c.surfaceMuted : 'transparent',
                })}
              >
                <Icon
                  ios={cluster.id === active?.id ? 'checkmark.circle.fill' : 'circle'}
                  android={cluster.id === active?.id ? 'check_circle' : 'radio_button_unchecked'}
                  size={18}
                  color={cluster.id === active?.id ? c.accent : c.textTertiary}
                />
                <Text style={{ ...Typography.callout, color: c.text }} numberOfLines={1}>
                  {cluster.name}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

// Lazy-import to avoid native module errors on web preview.
function SearchInput({
  value,
  onChange,
  placeholderColor,
  textColor,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholderColor: string;
  textColor: string;
}) {
  const { TextInput } = require('react-native') as typeof import('react-native');
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="Search resources"
      placeholderTextColor={placeholderColor}
      autoCorrect={false}
      autoCapitalize="none"
      style={[styles.search, { color: textColor }]}
    />
  );
}

const styles = StyleSheet.create({
  search: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
});
