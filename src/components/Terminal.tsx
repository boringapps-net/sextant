import React, { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useScheme } from '@/lib/ui/scheme';
import { Colors } from '@/lib/ui/theme';

// A real terminal emulator. We embed xterm.js inside a WebView and bridge
// bytes between native (the WebSocket transport in K8sClient) and the terminal:
//
//   stdout/stderr bytes → write(base64) → term.write
//   user keypress → term.onData → postMessage({ t:'input', d:base64 })
//   term.onResize → postMessage({ t:'resize', cols, rows })
//
// This is the same pattern Termius and other production mobile SSH clients use:
// xterm.js is the de-facto terminal emulator (VSCode, JupyterLab) and handles
// full VT100/xterm including vim, top, htop, colours, cursor positioning.

export type TerminalRef = {
  // Write a base64-encoded chunk to the terminal.
  writeBase64(b64: string): void;
  // Append a UTF-8 string (will be base64-wrapped for transit).
  writeText(text: string): void;
  // Force xterm + FitAddon to recompute its rows/cols against the current
  // WebView viewport. Call after the parent has resized (e.g. keyboard show).
  fit(): void;
};

type Props = {
  onInput: (base64: string) => void;
  onResize: (cols: number, rows: number) => void;
  onReady: (cols: number, rows: number) => void;
};

// xterm.js is loaded from a CDN inside the WebView. We use a pinned version
// for reproducibility. (Future: bundle as an asset for offline-first usage.)
const HTML = `
<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
    <style>
      html, body { margin: 0; padding: 0; background: #0b0b0e; height: 100%; overflow: hidden; }
      #t { position: absolute; inset: 0; padding: 6px 8px; }
      .xterm-viewport { background-color: transparent !important; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  </head>
  <body>
    <div id="t"></div>
    <script>
      (function () {
        function post(o) { window.ReactNativeWebView.postMessage(JSON.stringify(o)); }
        try {
          const term = new Terminal({
            convertEol: false,
            cursorBlink: true,
            // Scrollback: how many lines to keep above the visible viewport.
            // xterm's default is 1000; bump it so users can scroll a long way
            // back through history before lines fall off the top.
            scrollback: 10000,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.1,
            theme: {
              background: '#0b0b0e',
              foreground: '#e7e7ea',
              cursor: '#5e9cff',
              selectionBackground: 'rgba(94,156,255,0.35)',
              black: '#1c1c1e', red: '#ff453a', green: '#30d158', yellow: '#ff9f0a',
              blue: '#5e9cff', magenta: '#bf5af2', cyan: '#64d2ff', white: '#e7e7ea',
              brightBlack: '#48484a', brightRed: '#ff6961', brightGreen: '#7adf64',
              brightYellow: '#ffb340', brightBlue: '#7daeff', brightMagenta: '#d18cff',
              brightCyan: '#86e1ff', brightWhite: '#ffffff',
            },
          });
          const fit = new FitAddon.FitAddon();
          term.loadAddon(fit);
          term.loadAddon(new WebLinksAddon.WebLinksAddon());
          term.open(document.getElementById('t'));
          requestAnimationFrame(function () {
            try { fit.fit(); } catch (e) {}
            post({ t: 'ready', cols: term.cols, rows: term.rows });
          });

          // Re-fit on viewport changes (rotation, keyboard, split view).
          let pending = null;
          function refit() {
            if (pending) cancelAnimationFrame(pending);
            pending = requestAnimationFrame(function () {
              try { fit.fit(); } catch (e) {}
            });
          }
          window.addEventListener('resize', refit);
          if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

          // User input → out as base64-encoded UTF-8.
          term.onData(function (data) {
            const bytes = new TextEncoder().encode(data);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            post({ t: 'input', d: btoa(bin) });
          });
          term.onResize(function (s) { post({ t: 'resize', cols: s.cols, rows: s.rows }); });

          // Bridges in.
          window.__k8s_write = function (b64) {
            try {
              const bin = atob(b64);
              term.write(bin);
            } catch (e) {
              post({ t: 'err', m: 'write decode: ' + (e && e.message) });
            }
          };
          window.__k8s_fit = refit;
          window.__k8s_focus = function () { term.focus(); };
          window.__k8s_clear = function () { term.clear(); };
        } catch (e) {
          post({ t: 'err', m: 'init: ' + (e && e.message) });
        }
      })();
      true;
    </script>
  </body>
</html>
`;

export const Terminal = forwardRef<TerminalRef, Props>(function Terminal(
  { onInput, onResize, onReady },
  ref,
) {
  const scheme = useScheme();
  const c = Colors[scheme];
  const webRef = useRef<WebView | null>(null);

  useImperativeHandle(ref, () => ({
    writeBase64(b64: string) {
      webRef.current?.injectJavaScript(`window.__k8s_write && window.__k8s_write(${JSON.stringify(b64)}); true;`);
    },
    writeText(text: string) {
      const b64 = textToB64(text);
      webRef.current?.injectJavaScript(`window.__k8s_write && window.__k8s_write(${JSON.stringify(b64)}); true;`);
    },
    fit() {
      webRef.current?.injectJavaScript(`window.__k8s_fit && window.__k8s_fit(); true;`);
    },
  }));

  function handleMessage(e: WebViewMessageEvent) {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.t === 'input') onInput(msg.d);
    else if (msg.t === 'resize') onResize(msg.cols, msg.rows);
    else if (msg.t === 'ready') onReady(msg.cols, msg.rows);
    else if (msg.t === 'err') {
      // eslint-disable-next-line no-console
      console.warn('[term]', msg.m);
    }
  }

  return (
    <View style={[styles.host, { backgroundColor: '#0b0b0e' }]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html: HTML, baseUrl: 'https://localhost/' }}
        style={styles.web}
        containerStyle={styles.web}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        javaScriptEnabled
        domStorageEnabled
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        onMessage={handleMessage}
      />
    </View>
  );
});

function textToB64(s: string): string {
  // Lightweight UTF-8 → base64 without depending on TextEncoder in RN.
  let bin = '';
  for (const ch of unescape(encodeURIComponent(s))) bin += ch;
  return globalThis.btoa(bin);
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  web: { flex: 1, backgroundColor: '#0b0b0e' },
});
