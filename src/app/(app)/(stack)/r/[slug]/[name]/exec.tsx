import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useScheme } from '@/lib/ui/scheme';
import { useClusters } from '@/lib/state/cluster-context';
import { Colors, Radii, Spacing, Typography } from '@/lib/ui/theme';
import { Glass } from '@/lib/ui/glass';
import { Icon } from '@/lib/ui/Icon';
import { Terminal, type TerminalRef } from '@/components/Terminal';
import type { ExecHandle } from '@/lib/k8s/client';

// Try these in order if the user hasn't picked a command. The first present in
// the container wins. We don't try-and-fall-back automatically: a websocket
// opens fine even if the command exits immediately, so we'd need to read the
// error channel to detect it. Letting the user pick is simpler and explicit.
const COMMAND_CHOICES = ['/bin/sh', '/bin/bash', '/bin/ash', '/bin/zsh'];

export default function PodExec() {
  const scheme = useScheme();
  const c = Colors[scheme];
  const headerHeight = useHeaderHeight();
  const { name, namespace } = useLocalSearchParams<{ name: string; namespace?: string }>();
  const { client } = useClusters();

  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | undefined>();
  const [command, setCommand] = useState<string>('/bin/sh');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'closed' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const termRef = useRef<TerminalRef | null>(null);
  const execRef = useRef<ExecHandle | null>(null);
  // Latest tty size reported by xterm; resize is forwarded to the pod.
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const terminalReadyRef = useRef(false);

  // Discover containers once.
  useEffect(() => {
    if (!client || !name) return;
    const def = { apiGroup: '', apiVersion: 'v1', plural: 'pods', namespaced: true };
    client
      .get<any>(def, name, namespace)
      .then((pod) => {
        const all = [
          ...(pod.spec?.initContainers ?? []),
          ...(pod.spec?.containers ?? []),
        ].map((cn: any) => cn.name);
        setContainers(all);
        setContainer((prev) => prev ?? all[0]);
      })
      .catch((e) => setError(e?.message ?? String(e)));
  }, [client, name, namespace]);

  const connect = useCallback(() => {
    if (!client || !name || !namespace || !container) return;
    execRef.current?.close();
    setError(null);
    setStatus('connecting');
    termRef.current?.writeText(`\r\n\x1b[2m=== exec ${container} -- ${command} ===\x1b[0m\r\n`);

    const handle = client.podExec(
      namespace,
      name,
      {
        container,
        command: [command],
        tty: true,
        stdin: true,
        stdout: true,
        stderr: true,
      },
      {
        onOpen: () => {
          setStatus('live');
          // If we knew the tty size before connection, send it now.
          const s = sizeRef.current;
          if (s) handle.resize(s.cols, s.rows);
        },
        onStdout: (bytes) => {
          if (!terminalReadyRef.current) return;
          termRef.current?.writeBase64(bytesToB64(bytes));
        },
        onStderr: (bytes) => {
          if (!terminalReadyRef.current) return;
          termRef.current?.writeBase64(bytesToB64(bytes));
        },
        onExit: (statusJson) => {
          // K8s writes a Status object to channel 3 on process exit.
          try {
            const s = JSON.parse(statusJson);
            const exit = s.status === 'Success' ? 0 : (s.details?.causes?.find((c: any) => c.reason === 'ExitCode')?.message ?? '?');
            termRef.current?.writeText(`\r\n\x1b[2m=== exited (${exit}) ===\x1b[0m\r\n`);
          } catch {
            // Best-effort. Just dump the raw payload.
            termRef.current?.writeText(`\r\n\x1b[2m${statusJson}\x1b[0m\r\n`);
          }
        },
        onClose: () => setStatus('closed'),
        onError: (err) => {
          setError(`${err.name ?? 'Error'}: ${err.message}`);
          setStatus('error');
        },
      },
    );
    execRef.current = handle;
  }, [client, name, namespace, container, command]);

  // (Re)connect whenever container or command changes — and once the terminal is ready.
  useEffect(() => {
    if (!terminalReadyRef.current) return;
    connect();
    return () => execRef.current?.close();
  }, [connect]);

  useEffect(() => {
    return () => execRef.current?.close();
  }, []);

  // Refit xterm whenever the keyboard appears or hides. KeyboardAvoidingView
  // shrinks the parent View which fires a window resize inside the WebView,
  // and xterm already has a resize listener — but this is the belt to that
  // pair of braces, ensuring a refit even if the resize event doesn't fire.
  useEffect(() => {
    const refit = () => {
      // Slight delay so the layout has finished animating before we measure.
      setTimeout(() => termRef.current?.fit(), 50);
    };
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      refit,
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      refit,
    );
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  function pickContainer() {
    if (containers.length === 0) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...containers, 'Cancel'], cancelButtonIndex: containers.length },
        (idx) => {
          if (idx < containers.length) setContainer(containers[idx]);
        },
      );
    }
  }

  function pickCommand() {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...COMMAND_CHOICES, 'Cancel'], cancelButtonIndex: COMMAND_CHOICES.length },
        (idx) => {
          if (idx < COMMAND_CHOICES.length) setCommand(COMMAND_CHOICES[idx]);
        },
      );
    }
  }

  const liveColor =
    status === 'live'
      ? c.success
      : status === 'connecting'
      ? c.warning
      : status === 'error'
      ? c.danger
      : c.textTertiary;
  const statusLabel =
    status === 'live'
      ? 'Connected'
      : status === 'connecting'
      ? 'Connecting'
      : status === 'closed'
      ? 'Closed'
      : status === 'error'
      ? 'Error'
      : 'Idle';

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen options={{ title: `${name ?? ''} · shell` }} />

      {/* On iOS the software keyboard overlays the WebView. KeyboardAvoidingView
          adds bottom padding equal to the keyboard height when it's up, which
          shrinks the terminal area; xterm's FitAddon refits on the resulting
          window resize event so rows/cols recompute correctly. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >

      {/* Controls bar — pushed below the transparent header */}
      <View style={{ paddingHorizontal: Spacing.lg, paddingTop: headerHeight + 4, gap: 8 }}>
        <Glass radius={Radii.md} style={{ padding: Spacing.sm, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Pressable
              onPress={pickContainer}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: c.surfaceMuted,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: Radii.pill,
              }}
            >
              <Icon ios="cube" android="layers" size={14} color={c.text} />
              <Text style={{ ...Typography.footnote, color: c.text, fontWeight: '600' }}>
                {container ?? '—'}
              </Text>
              <Icon ios="chevron.down" android="expand_more" size={12} color={c.textSecondary} />
            </Pressable>
            <Pressable
              onPress={pickCommand}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: c.surfaceMuted,
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: Radii.pill,
              }}
            >
              <Icon ios="terminal" android="terminal" size={14} color={c.text} />
              <Text
                style={{
                  ...Typography.footnote,
                  color: c.text,
                  fontWeight: '600',
                  fontFamily: Typography.mono.fontFamily,
                }}
              >
                {command}
              </Text>
              <Icon ios="chevron.down" android="expand_more" size={12} color={c.textSecondary} />
            </Pressable>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: liveColor }} />
              <Text style={{ ...Typography.caption1, color: c.textSecondary }}>{statusLabel}</Text>
              {status !== 'live' && status !== 'connecting' ? (
                <Pressable
                  onPress={connect}
                  hitSlop={10}
                  style={{
                    marginLeft: 6,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: Radii.sm,
                    backgroundColor: c.accentSubtle,
                  }}
                >
                  <Text style={{ ...Typography.caption1, color: c.accent, fontWeight: '600' }}>
                    Reconnect
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </Glass>
      </View>

      {error ? (
        <View style={{ paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm }}>
          <Text selectable style={{ color: c.danger, ...Typography.footnote }}>
            {error}
          </Text>
        </View>
      ) : null}

      <View style={{ flex: 1, marginTop: Spacing.sm, marginHorizontal: Spacing.md, marginBottom: Spacing.md, borderRadius: Radii.md, overflow: 'hidden' }}>
        {!container ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={c.accent} />
          </View>
        ) : (
          <Terminal
            ref={termRef}
            onInput={(b64) => {
              const bytes = b64ToBytes(b64);
              execRef.current?.write(bytes);
            }}
            onResize={(cols, rows) => {
              sizeRef.current = { cols, rows };
              execRef.current?.resize(cols, rows);
            }}
            onReady={(cols, rows) => {
              terminalReadyRef.current = true;
              sizeRef.current = { cols, rows };
              connect();
            }}
          />
        )}
      </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// Local helpers — keep these in sync with the ones in K8sClient. Self-contained
// so the screen doesn't reach into client internals.
function b64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return globalThis.btoa(bin);
}
