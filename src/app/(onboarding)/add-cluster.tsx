import { useState } from 'react';
import { useScheme } from "@/lib/ui/scheme";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { authForContext, parseKubeconfig } from '@/lib/k8s/kubeconfig';
import { K8sClient, type ClusterConnection } from '@/lib/k8s/client';
import { generateClusterId } from '@/lib/storage/clusters';
import { buildPKCS12FromPEM, caPEMtoDerB64 } from '@/lib/k8s/pkcs12';
import { useClusters } from '@/lib/state/cluster-context';
import { K8sError } from '@/lib/k8s/client';

type Mode = 'paste' | 'manual';

export default function AddCluster() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const router = useRouter();
  const { saveAndActivate } = useClusters();
  const [mode, setMode] = useState<Mode>('paste');
  const [yaml, setYaml] = useState('');
  const [contextName, setContextName] = useState('');
  const [manual, setManual] = useState({
    name: '',
    server: '',
    token: '',
    namespace: '',
    caPem: '',
    insecure: false,
  });
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<{ title: string; detail: string } | null>(null);

  async function importFromPaste() {
    setBusy(true);
    try {
      const parsed = parseKubeconfig(yaml);
      if (!parsed.ok) {
        Alert.alert('Could not parse kubeconfig', parsed.error);
        return;
      }
      const cfg = parsed.config;
      const targetCtx = contextName || cfg.currentContext || cfg.contexts[0]?.name;
      if (!targetCtx) {
        Alert.alert('No context in kubeconfig');
        return;
      }
      const auth = authForContext(cfg, targetCtx);
      if (!auth) {
        Alert.alert('Context not found');
        return;
      }
      if (auth.auth.kind === 'exec-unsupported') {
        Alert.alert(
          'Exec-based auth not supported',
          `This kubeconfig uses an exec plugin (${auth.auth.command}). Run "${auth.auth.command}" on your computer to get a bearer token, then paste a kubeconfig with a token user.`,
        );
        return;
      }
      if (auth.auth.kind === 'none') {
        Alert.alert('No usable credentials in selected context');
        return;
      }

      const id = generateClusterId();
      // Build PKCS12 + CA DER bundle here so all heavy crypto stays in JS, off the native side.
      let pkcs12Base64: string | undefined;
      let pkcs12Password: string | undefined;
      if (auth.auth.kind === 'client-cert') {
        try {
          const bundle = buildPKCS12FromPEM(auth.auth.clientCertificatePem, auth.auth.clientKeyPem);
          pkcs12Base64 = bundle.pkcs12Base64;
          pkcs12Password = bundle.pkcs12Password;
        } catch (e: any) {
          Alert.alert('Could not package client certificate', e?.message ?? String(e));
          return;
        }
      }
      const caBundlesDerBase64 = auth.cluster.caData
        ? caPEMtoDerB64(globalThis.atob(auth.cluster.caData))
        : undefined;

      const conn: ClusterConnection = {
        id,
        name: targetCtx,
        server: auth.cluster.server,
        token: auth.auth.kind === 'token' ? auth.auth.token : undefined,
        username: auth.auth.kind === 'basic' ? auth.auth.username : undefined,
        password: auth.auth.kind === 'basic' ? auth.auth.password : undefined,
        pkcs12Base64,
        pkcs12Password,
        caBundlesDerBase64,
        insecureSkipTLSVerify: auth.cluster.insecureSkipTLSVerify,
        tlsServerName: auth.cluster.tlsServerName,
        defaultNamespace: auth.context.namespace,
      };
      await testAndSave(conn);
    } finally {
      setBusy(false);
    }
  }

  async function importManual() {
    if (!manual.server || !manual.name) {
      Alert.alert('Server URL and name are required');
      return;
    }
    setBusy(true);
    try {
      const id = generateClusterId();
      let caBundlesDerBase64: string[] | undefined;
      if (manual.caPem.trim()) {
        const ders = caPEMtoDerB64(manual.caPem);
        if (ders.length === 0) {
          Alert.alert('CA bundle has no CERTIFICATE blocks', 'Expected one or more PEM "-----BEGIN CERTIFICATE-----" blocks.');
          setBusy(false);
          return;
        }
        caBundlesDerBase64 = ders;
      }
      const conn: ClusterConnection = {
        id,
        name: manual.name,
        server: manual.server.trim(),
        token: manual.token.trim() || undefined,
        defaultNamespace: manual.namespace || undefined,
        caBundlesDerBase64,
        insecureSkipTLSVerify: manual.insecure || undefined,
      };
      await testAndSave(conn);
    } finally {
      setBusy(false);
    }
  }

  async function testAndSave(conn: ClusterConnection) {
    setLastError(null);
    try {
      const client = new K8sClient(conn);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const info = await client.ping(ctrl.signal);
      clearTimeout(t);
      await saveAndActivate(conn);
      Alert.alert(
        'Connected',
        `Kubernetes ${info.gitVersion} on ${info.platform}`,
        [
          {
            text: 'OK',
            onPress: () => {
              // Navigate after the user has acknowledged, so the alert doesn't race
              // with the route change. dismissAll covers the modal-stack history,
              // then we hand off to the (app) drawer.
              router.dismissAll?.();
              router.replace('/(app)/(stack)');
            },
          },
        ],
        { cancelable: false },
      );
    } catch (e: any) {
      // Build the most diagnostic message we can. Cases we care about:
      //   - K8sError (HTTP non-2xx) → show status + first 400 chars of body
      //   - AbortError (timeout) → ours fired at 10s
      //   - "Network request failed" → almost always TLS trust or unreachable host
      //   - DNS / connection refused → message will say so on iOS/Android
      const isAbort = e?.name === 'AbortError';
      const transport = e?.code ?? e?.name ?? 'Error';
      let title = 'Could not reach cluster';
      let detail: string;
      if (e instanceof K8sError) {
        title = `HTTP ${e.status}`;
        detail = `The API replied with ${e.status}.\n\nResponse body:\n${e.body.slice(0, 600) || '(empty)'}\n\nServer: ${conn.server}`;
      } else if (isAbort) {
        title = 'Request timed out';
        detail = `No response from ${conn.server} within 10s. The host might be unreachable from this device (VPN? simulator can't see 10.x?).`;
      } else {
        const msg = e?.message ?? String(e);
        const looksLikeTLS =
          /network request failed|trust|certificate|ssl|handshake|self.?signed|hostname|tls/i.test(
            msg,
          );
        detail =
          `${transport}: ${msg}\n\nServer: ${conn.server}` +
          (looksLikeTLS && !conn.insecureSkipTLSVerify && !conn.caBundlesDerBase64?.length
            ? '\n\nThis often means the device does not trust the cluster cert. If your cluster has a private CA, paste its PEM into the "CA certificate" box below. For a homelab cluster you can also tick "Skip TLS verify" to bypass validation.'
            : '');
      }
      setLastError({ title, detail });
      Alert.alert(title, detail);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: c.background }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: Spacing.lg, paddingBottom: 60 }}
      >
        {/* Mode picker */}
        <View
          style={{
            flexDirection: 'row',
            padding: 4,
            borderRadius: Radii.md,
            backgroundColor: c.surfaceMuted,
            marginBottom: Spacing.lg,
          }}
        >
          {(['paste', 'manual'] as Mode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: Radii.sm,
                backgroundColor: mode === m ? c.surface : 'transparent',
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  ...Typography.subhead,
                  color: mode === m ? c.text : c.textSecondary,
                  fontWeight: '600',
                }}
              >
                {m === 'paste' ? 'Paste kubeconfig' : 'Server + token'}
              </Text>
            </Pressable>
          ))}
        </View>

        {mode === 'paste' ? (
          <Glass radius={Radii.lg} style={{ padding: Spacing.md, gap: Spacing.sm }}>
            <Label text="Kubeconfig YAML" />
            <TextInput
              value={yaml}
              onChangeText={setYaml}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: ..."
              placeholderTextColor={c.textTertiary}
              style={{
                minHeight: 180,
                color: c.text,
                fontFamily: Typography.mono.fontFamily,
                fontSize: 12,
                backgroundColor: c.surface,
                borderRadius: Radii.md,
                padding: Spacing.md,
                textAlignVertical: 'top',
              }}
            />
            <Label text="Context name (optional)" />
            <Input value={contextName} onChangeText={setContextName} placeholder="defaults to current-context" />
            <Helper text="The bearer token in the selected context is stored encrypted on this device only." />
          </Glass>
        ) : (
          <Glass radius={Radii.lg} style={{ padding: Spacing.md, gap: Spacing.sm }}>
            <Label text="Display name" />
            <Input
              value={manual.name}
              onChangeText={(t) => setManual((m) => ({ ...m, name: t }))}
              placeholder="prod-eu"
            />
            <Label text="API server URL" />
            <Input
              value={manual.server}
              onChangeText={(t) => setManual((m) => ({ ...m, server: t }))}
              placeholder="https://api.example.com:6443"
              keyboardType="url"
            />
            <Label text="Bearer token" />
            <Input
              value={manual.token}
              onChangeText={(t) => setManual((m) => ({ ...m, token: t }))}
              placeholder="eyJhbGciOi..."
              secureTextEntry
              multiline
            />
            <Label text="Default namespace (optional)" />
            <Input
              value={manual.namespace}
              onChangeText={(t) => setManual((m) => ({ ...m, namespace: t }))}
              placeholder="default"
            />

            {/* Advanced TLS — only renders these as separate stays-on rows. */}
            <View style={{ marginTop: Spacing.md, paddingTop: Spacing.sm, borderTopWidth: 0.5, borderTopColor: c.separator }}>
              <Label text="CA certificate (optional)" />
              <Input
                value={manual.caPem}
                onChangeText={(t) => setManual((m) => ({ ...m, caPem: t }))}
                placeholder="-----BEGIN CERTIFICATE-----&#10;... your cluster CA ..."
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                style={{
                  minHeight: 90,
                  fontFamily: Typography.mono.fontFamily,
                  fontSize: 11,
                  textAlignVertical: 'top',
                }}
              />
              <Helper text='Paste the cluster CA bundle if it is signed by a private CA. Run `kubectl config view --raw -o jsonpath="{.clusters[0].cluster.certificate-authority-data}" | base64 -d` to get it.' />

              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  marginTop: Spacing.md,
                  gap: Spacing.sm,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ ...Typography.subhead, color: c.text, fontWeight: '600' }}>
                    Skip TLS verify
                  </Text>
                  <Text style={{ ...Typography.caption1, color: c.textTertiary, marginTop: 2 }}>
                    Bypass cert validation. Only for homelab clusters you trust.
                  </Text>
                </View>
                <Switch
                  value={manual.insecure}
                  onValueChange={(v) => setManual((m) => ({ ...m, insecure: v }))}
                />
              </View>
            </View>
          </Glass>
        )}

        {lastError ? (
          <Glass radius={Radii.lg} style={{ padding: Spacing.md, marginTop: Spacing.md, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon ios="exclamationmark.triangle.fill" android="warning" size={18} color={c.danger} />
              <Text style={{ ...Typography.headline, color: c.danger, flex: 1 }}>
                {lastError.title}
              </Text>
            </View>
            <Text
              selectable
              style={{ ...Typography.footnote, color: c.text, fontFamily: Typography.mono.fontFamily }}
            >
              {lastError.detail}
            </Text>
          </Glass>
        ) : null}

        <Pressable
          onPress={mode === 'paste' ? importFromPaste : importManual}
          disabled={busy}
          style={({ pressed }) => ({
            marginTop: Spacing.xl,
            backgroundColor: busy ? c.surfaceMuted : pressed ? c.accent + 'CC' : c.accent,
            paddingVertical: 16,
            borderRadius: Radii.lg,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 8,
          })}
        >
          <Icon ios="link" android="link" size={18} color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 17 }}>
            {busy ? 'Connecting…' : 'Test & save'}
          </Text>
        </Pressable>

        <Text
          style={{
            ...Typography.caption1,
            color: c.textTertiary,
            marginTop: Spacing.lg,
            textAlign: 'center',
          }}
        >
          Tip: for managed clusters, run{' '}
          <Text style={{ fontFamily: Typography.mono.fontFamily }}>
            kubectl create token my-sa --duration=24h
          </Text>{' '}
          to mint a short-lived bearer token.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Label({ text }: { text: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <Text
      style={{
        ...Typography.footnote,
        color: c.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.7,
        marginTop: 6,
      }}
    >
      {text}
    </Text>
  );
}

function Helper({ text }: { text: string }) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return <Text style={{ ...Typography.caption1, color: c.textTertiary, marginTop: 4 }}>{text}</Text>;
}

function Input(props: React.ComponentProps<typeof TextInput>) {
  const scheme = useScheme();
  const c = Colors[scheme];
  return (
    <TextInput
      placeholderTextColor={c.textTertiary}
      {...props}
      style={[
        {
          backgroundColor: c.surface,
          borderRadius: Radii.md,
          paddingHorizontal: Spacing.md,
          paddingVertical: 12,
          color: c.text,
          fontSize: 15,
        },
        props.style,
      ]}
    />
  );
}
