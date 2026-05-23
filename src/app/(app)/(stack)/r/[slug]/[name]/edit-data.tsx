import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useScheme } from '@/lib/ui/scheme';
import { useClusters } from '@/lib/state/cluster-context';
import { useCRDs } from '@/lib/state/crds-context';
import { BUILTIN_RESOURCES, parseSlug, type ResourceDef } from '@/lib/k8s/resources';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { useWatchedItem } from '@/lib/state/use-watched-item';
import type { K8sObject } from '@/lib/k8s/types';

type Row = {
  // Stable React key — survives renders even while the user is editing the key text.
  id: string;
  // Original key from the loaded object; null for rows the user just added.
  originalKey: string | null;
  // What the user has typed.
  key: string;
  // Decoded value the user is editing (UTF-8 plain text for both ConfigMap and Secret).
  value: string;
  // True when the original bytes failed UTF-8 decoding — show as a read-only placeholder.
  isBinary: boolean;
  // Whether the value is currently un-masked. Secrets start masked, ConfigMaps and new
  // rows are always revealed.
  revealed: boolean;
};

// Decode base64 → UTF-8 string with strict validation. Returns ok:false for
// non-UTF-8 bytes (e.g. helm release blobs, TLS certificates as DER).
function decodeBase64Utf8(b64: string): { ok: true; text: string } | { ok: false } {
  try {
    const bin = globalThis.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}

function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa(bin);
}

export default function EditData() {
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

  const def: ResourceDef | undefined = useMemo(() => {
    if (!slug) return undefined;
    const builtin = BUILTIN_RESOURCES.find((r) => r.slug === slug);
    if (builtin) return builtin;
    const { plural, apiGroup } = parseSlug(slug);
    return crds.find((r) => r.plural === plural && r.apiGroup === apiGroup);
  }, [slug, crds]);

  const isSecret = def?.kind === 'Secret';
  const supported = def?.kind === 'Secret' || def?.kind === 'ConfigMap';

  // Live load so we can seed from current cluster state. Subsequent updates
  // are deliberately ignored — see the seeded flag below.
  const { item: obj, loading } = useWatchedItem<K8sObject>(def, name, namespace);

  const [rows, setRows] = useState<Row[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed once from the first non-null obj. Re-seeding on every live update
  // would wipe out anything the user has typed but not yet saved.
  useEffect(() => {
    if (!supported || seeded || !obj) return;
    const data = (obj.data as Record<string, string> | undefined) ?? {};
    const next: Row[] = Object.entries(data).map(([k, raw], i) => {
      if (isSecret) {
        const d = decodeBase64Utf8(raw ?? '');
        return {
          id: `r${i}`,
          originalKey: k,
          key: k,
          value: d.ok ? d.text : raw ?? '',
          isBinary: !d.ok,
          revealed: false,
        };
      }
      return {
        id: `r${i}`,
        originalKey: k,
        key: k,
        value: raw ?? '',
        isBinary: false,
        revealed: true,
      };
    });
    setRows(next);
    setSeeded(true);
  }, [obj, isSecret, seeded, supported]);

  function update(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function remove(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function add() {
    setRows((rs) => [
      ...rs,
      {
        id: `n${Math.random().toString(36).slice(2, 9)}`,
        originalKey: null,
        key: '',
        value: '',
        isBinary: false,
        // Always-revealed for new rows: the user just typed it, masking is pointless until save.
        revealed: true,
      },
    ]);
  }

  async function save() {
    if (!client || !def || !name) return;

    // Validate keys client-side so we don't paste a bad patch at the API.
    const trimmed = rows.map((r) => ({ ...r, key: r.key.trim() }));
    const seen = new Set<string>();
    for (const r of trimmed) {
      if (!r.key) {
        Alert.alert('Empty key', 'Every entry needs a key.');
        return;
      }
      // K8s key rules: alnum, dash, underscore, dot.
      if (!/^[A-Za-z0-9._-]+$/.test(r.key)) {
        Alert.alert('Invalid key', `"${r.key}" — keys must be alphanumeric with - _ .`);
        return;
      }
      if (seen.has(r.key)) {
        Alert.alert('Duplicate key', `"${r.key}" appears twice. Keys must be unique.`);
        return;
      }
      seen.add(r.key);
    }

    // Build a JSON-merge-patch body. New / changed keys carry encoded values;
    // any key present in the original but missing from `rows` becomes null so
    // the API server deletes it.
    const data: Record<string, string | null> = {};
    const originalKeys = new Set(
      Object.keys(((obj as K8sObject | null)?.data as Record<string, string>) ?? {}),
    );
    const originalRaw = ((obj as K8sObject | null)?.data as Record<string, string>) ?? {};

    for (const r of trimmed) {
      if (r.isBinary && r.originalKey === r.key) {
        // Untouched binary value — preserve the original base64 verbatim so
        // we don't accidentally re-encode the placeholder string.
        data[r.key] = originalRaw[r.originalKey];
      } else {
        data[r.key] = isSecret ? encodeBase64Utf8(r.value) : r.value;
      }
      // Whatever key we just wrote no longer counts as "removed".
      originalKeys.delete(r.key);
    }
    for (const removedKey of originalKeys) {
      data[removedKey] = null;
    }

    setSaving(true);
    try {
      await client.patch(
        def,
        name,
        { data },
        { namespace, contentType: 'application/merge-patch+json' },
      );
      router.back();
    } catch (e: any) {
      Alert.alert('Save failed', e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!supported) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: Spacing.lg }}>
        <Stack.Screen options={{ title: 'Edit' }} />
        <Text style={{ color: c.text, ...Typography.body }}>
          Editing is only supported for Secrets and ConfigMaps.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen
        options={{
          title: `Edit ${def!.kind.toLowerCase()}`,
          headerBackTitle: name ?? 'Back',
          headerRight: () =>
            saving ? (
              <ActivityIndicator color={c.accent} />
            ) : (
              <Pressable hitSlop={12} disabled={!seeded} onPress={save}>
                {/* SF Symbols has no literal floppy; `square.and.arrow.down` reads
                    as "save" on iOS and Material's `save` is the floppy on Android. */}
                <Icon
                  ios="square.and.arrow.down"
                  android="save"
                  size={20}
                  color={!seeded ? c.textTertiary : c.accent}
                />
              </Pressable>
            ),
        }}
      />

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 80, gap: Spacing.md }}
        keyboardShouldPersistTaps="handled"
      >
        {loading && !obj ? (
          <Text style={{ color: c.textSecondary, ...Typography.subhead }}>Loading…</Text>
        ) : (
          <>
            <Glass radius={Radii.lg} style={{ padding: Spacing.md, gap: Spacing.md }}>
              {rows.length === 0 ? (
                <Text style={{ color: c.textSecondary, ...Typography.subhead }}>
                  No fields yet. Tap “Add field” below.
                </Text>
              ) : (
                rows.map((r) => (
                  <RowEditor
                    key={r.id}
                    row={r}
                    isSecret={isSecret}
                    onChange={(p) => update(r.id, p)}
                    onRemove={() => remove(r.id)}
                  />
                ))
              )}
            </Glass>

            <Pressable
              onPress={add}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingVertical: 12,
                backgroundColor: pressed ? c.accent + 'CC' : c.accent,
                borderRadius: Radii.lg,
              })}
            >
              <Icon ios="plus.circle.fill" android="add_circle" size={18} color="#fff" />
              <Text style={{ color: '#fff', ...Typography.subhead, fontWeight: '600' }}>
                Add field
              </Text>
            </Pressable>

            <Text
              style={{
                color: c.textTertiary,
                ...Typography.caption1,
                textAlign: 'center',
                marginTop: 4,
              }}
            >
              {isSecret
                ? 'Values are base64-encoded on save. Binary fields aren’t editable here.'
                : 'Values are stored as plain text.'}
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function RowEditor({
  row,
  isSecret,
  onChange,
  onRemove,
}: {
  row: Row;
  isSecret: boolean;
  onChange: (p: Partial<Row>) => void;
  onRemove: () => void;
}) {
  const scheme = useScheme();
  const c = Colors[scheme];

  return (
    <View
      style={{
        gap: 6,
        paddingBottom: Spacing.sm,
        borderBottomWidth: 0.5,
        borderBottomColor: c.separator,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.sm }}>
        <TextInput
          value={row.key}
          onChangeText={(t) => onChange({ key: t })}
          placeholder="key"
          placeholderTextColor={c.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            flex: 1,
            backgroundColor: c.surface,
            color: c.text,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: Radii.md,
            fontFamily: Typography.mono.fontFamily,
            fontSize: 13,
          }}
        />
        {isSecret && !row.isBinary ? (
          <Pressable hitSlop={10} onPress={() => onChange({ revealed: !row.revealed })}>
            <Icon
              ios={row.revealed ? 'eye.slash' : 'eye'}
              android={row.revealed ? 'visibility_off' : 'visibility'}
              size={18}
              color={c.textSecondary}
            />
          </Pressable>
        ) : null}
        <Pressable hitSlop={10} onPress={onRemove}>
          <Icon ios="trash" android="delete" size={18} color={c.danger} />
        </Pressable>
      </View>

      {row.isBinary ? (
        <View
          style={{
            backgroundColor: c.surfaceMuted,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: Radii.md,
          }}
        >
          <Text
            style={{
              color: c.textTertiary,
              ...Typography.caption1,
              fontStyle: 'italic',
            }}
          >
            [binary] — original bytes preserved on save; not editable here.
          </Text>
        </View>
      ) : isSecret && !row.revealed ? (
        // Masked secret value: render a tappable masked-bar (not a TextInput).
        // RN's secureTextEntry can't be combined with multiline on iOS, and
        // dot-replacing on the fly fights the keyboard cursor. The clean answer
        // is a "reveal to edit" gate, which also matches 1Password/Bitwarden.
        <Pressable
          onPress={() => onChange({ revealed: true })}
          style={({ pressed }) => ({
            backgroundColor: c.surface,
            paddingHorizontal: Spacing.md,
            paddingVertical: 12,
            borderRadius: Radii.md,
            opacity: pressed ? 0.6 : 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          })}
        >
          <Text
            style={{
              flex: 1,
              color: c.text,
              fontFamily: Typography.mono.fontFamily,
              fontSize: 13,
              letterSpacing: 2,
            }}
          >
            {'•'.repeat(Math.min(Math.max(row.value.length, 8), 20))}
          </Text>
          <Text style={{ color: c.textTertiary, ...Typography.caption1 }}>tap to reveal</Text>
        </Pressable>
      ) : (
        <TextInput
          value={row.value}
          onChangeText={(t) => onChange({ value: t })}
          placeholder="value"
          placeholderTextColor={c.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={{
            backgroundColor: c.surface,
            color: c.text,
            paddingHorizontal: Spacing.md,
            paddingVertical: 10,
            borderRadius: Radii.md,
            fontFamily: Typography.mono.fontFamily,
            fontSize: 13,
            minHeight: 60,
            textAlignVertical: 'top',
          }}
        />
      )}
    </View>
  );
}
