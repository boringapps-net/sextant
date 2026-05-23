import {
  nativeRequest,
  nativeStream,
  nativeWebSocket,
  type StreamHandle,
  type WsHandle,
} from 'expo-k8s-mtls';
import type {
  APIGroupList,
  APIResourceList,
  K8sList,
  K8sObject,
} from './types';
import type { MetricsList, NodeMetrics, PodMetrics } from './metrics';
import { makeWatchParser, type WatchEvent } from './watch';
import { log, redact } from '../util/diag';

// What we persist for a cluster connection.
export type ClusterConnection = {
  id: string;
  name: string;
  server: string;          // https://host:port
  token?: string;          // bearer token
  username?: string;
  password?: string;
  // mTLS — populated when the kubeconfig user has client-certificate-data + client-key-data.
  // pkcs12Base64 is built from the cert+key at import time and stored in SecureStore.
  pkcs12Base64?: string;
  pkcs12Password?: string;
  // CA bundle for server-cert validation. Stored as base64-encoded DER (one cert each)
  // so the native side doesn't have to deal with PEM parsing.
  caBundlesDerBase64?: string[];
  insecureSkipTLSVerify?: boolean;
  // Override SNI / cert-hostname validation (matches kubeconfig `tls-server-name`).
  tlsServerName?: string;
  defaultNamespace?: string;
};

export type ListOptions = {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  limit?: number;
  signal?: AbortSignal;
};

export type GetOptions = {
  signal?: AbortSignal;
};

export type ExecHandle = {
  write(input: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;
};

// Minimal base64 ↔ bytes helpers. globalThis.btoa/atob give us latin1 strings
// that we can index byte-wise. For UTF-8 data we go through TextEncoder /
// TextDecoder which Hermes ships.
function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function bytesToString(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}
function bytesToBase64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return globalThis.btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class K8sError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Kubernetes API error ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

// Returns true when the connection requires TLS plumbing that JS fetch can't provide.
function needsNativeTransport(conn: ClusterConnection): boolean {
  return !!(
    conn.pkcs12Base64 ||
    (conn.caBundlesDerBase64 && conn.caBundlesDerBase64.length > 0) ||
    conn.insecureSkipTLSVerify
  );
}

export class K8sClient {
  constructor(public conn: ClusterConnection) {}

  // Just the credential header. WebSocket upgrades reject Accept: application/json
  // on endpoints that don't produce JSON (K8s exec returns 406), so callers that
  // shouldn't send Accept use this directly.
  private credentialHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.conn.token) h['Authorization'] = `Bearer ${this.conn.token}`;
    else if (this.conn.username && this.conn.password) {
      const enc = globalThis.btoa(`${this.conn.username}:${this.conn.password}`);
      h['Authorization'] = `Basic ${enc}`;
    }
    return h;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Accept: 'application/json', ...this.credentialHeaders(), ...(extra ?? {}) };
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.conn.server.replace(/\/+$/, '');
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return `${base}${path}${qs}`;
  }

  private resourcePath(opts: {
    apiGroup: string;
    apiVersion: string;
    plural: string;
    namespace?: string;
    name?: string;
    subresource?: string;
  }): string {
    const root = opts.apiGroup === '' ? `/api/${opts.apiVersion}` : `/apis/${opts.apiGroup}/${opts.apiVersion}`;
    const ns = opts.namespace ? `/namespaces/${opts.namespace}` : '';
    const name = opts.name ? `/${opts.name}` : '';
    const sub = opts.subresource ? `/${opts.subresource}` : '';
    return `${root}${ns}/${opts.plural}${name}${sub}`;
  }

  // Unified request that picks the right transport. Native is used when mTLS / custom CA / insecure
  // are in play; otherwise we use fetch so we keep AbortSignal support and don't load the native
  // module unless we have to (helps in Expo Go fallback for token-only clusters).
  private async raw(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      accept?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ status: number; text: string }> {
    const url = path.startsWith('http') ? path : this.url(path);
    const headers = this.authHeaders({
      ...(init.headers ?? {}),
      ...(init.accept ? { Accept: init.accept } : {}),
    });
    const method = (init.method ?? 'GET').toUpperCase();
    const transport = needsNativeTransport(this.conn) ? 'native' : 'fetch';
    const t0 = Date.now();

    log({ kind: 'request', transport, method, url, headers: redact(headers) });

    try {
      let status: number;
      let text: string;
      if (transport === 'native') {
        const reqPromise = nativeRequest({
          url,
          method: method as any,
          headers,
          body: init.body,
          pkcs12Base64: this.conn.pkcs12Base64,
          pkcs12Password: this.conn.pkcs12Password,
          caBundlesDerBase64: this.conn.caBundlesDerBase64,
          insecureSkipTLSVerify: this.conn.insecureSkipTLSVerify,
          tlsServerName: this.conn.tlsServerName,
          timeoutSeconds: 30,
        });
        const res = init.signal
          ? await Promise.race([
              reqPromise,
              new Promise<never>((_, reject) => {
                if (init.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
                init.signal!.addEventListener('abort', () =>
                  reject(new DOMException('Aborted', 'AbortError')),
                );
              }),
            ])
          : await reqPromise;
        status = res.status;
        text = res.body;
      } else {
        const res = await fetch(url, {
          method,
          headers,
          body: init.body,
          signal: init.signal,
        });
        status = res.status;
        text = await res.text();
      }
      log({
        kind: 'response',
        transport,
        method,
        url,
        status,
        ms: Date.now() - t0,
        bodyPreview: text.slice(0, 160),
      });
      return { status, text };
    } catch (e: any) {
      log({
        kind: 'error',
        transport,
        method,
        url,
        ms: Date.now() - t0,
        name: e?.name,
        message: e?.message ?? String(e),
        code: e?.code,
      });
      throw e;
    }
  }

  private async jsonOrThrow<T>(res: { status: number; text: string }): Promise<T> {
    if (res.status < 200 || res.status >= 300) throw new K8sError(res.status, res.text);
    return res.text ? (JSON.parse(res.text) as T) : ({} as T);
  }

  async list<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean },
    opts: ListOptions = {},
  ): Promise<K8sList<T>> {
    const ns = rdef.namespaced ? opts.namespace : undefined;
    const path = this.resourcePath({
      apiGroup: rdef.apiGroup,
      apiVersion: rdef.apiVersion,
      plural: rdef.plural,
      namespace: ns,
    });
    const url = this.url(path, {
      labelSelector: opts.labelSelector,
      fieldSelector: opts.fieldSelector,
      limit: opts.limit,
    });
    return this.jsonOrThrow(await this.raw(url, { signal: opts.signal }));
  }

  async get<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean },
    name: string,
    namespace?: string,
    opts: GetOptions = {},
  ): Promise<T> {
    const path = this.resourcePath({
      apiGroup: rdef.apiGroup,
      apiVersion: rdef.apiVersion,
      plural: rdef.plural,
      namespace: rdef.namespaced ? namespace : undefined,
      name,
    });
    return this.jsonOrThrow(await this.raw(path, { signal: opts.signal }));
  }

  async delete(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean },
    name: string,
    namespace?: string,
    body?: object,
  ): Promise<unknown> {
    const path = this.resourcePath({
      apiGroup: rdef.apiGroup,
      apiVersion: rdef.apiVersion,
      plural: rdef.plural,
      namespace: rdef.namespaced ? namespace : undefined,
      name,
    });
    const res = await this.raw(path, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status < 200 || res.status >= 300) throw new K8sError(res.status, res.text);
    return res.text ? JSON.parse(res.text) : {};
  }

  async patch(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean },
    name: string,
    patch: object,
    options: { namespace?: string; subresource?: string; contentType?: string } = {},
  ): Promise<unknown> {
    const ct = options.contentType ?? 'application/strategic-merge-patch+json';
    const path = this.resourcePath({
      apiGroup: rdef.apiGroup,
      apiVersion: rdef.apiVersion,
      plural: rdef.plural,
      namespace: rdef.namespaced ? options.namespace : undefined,
      name,
      subresource: options.subresource,
    });
    return this.jsonOrThrow(
      await this.raw(path, {
        method: 'PATCH',
        headers: { 'Content-Type': ct },
        body: JSON.stringify(patch),
      }),
    );
  }

  async podLogs(
    namespace: string,
    name: string,
    options: {
      container?: string;
      tailLines?: number;
      previous?: boolean;
      timestamps?: boolean;
      sinceSeconds?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<string> {
    const url = this.url(`/api/v1/namespaces/${namespace}/pods/${name}/log`, {
      container: options.container,
      tailLines: options.tailLines ?? 500,
      previous: options.previous ? 'true' : undefined,
      timestamps: options.timestamps ? 'true' : undefined,
      sinceSeconds: options.sinceSeconds,
    });
    // K8s /log returns text/plain. Some clusters (or proxies) reject a bare `Accept: text/plain`
    // with 406 — sending the full Apache-style q-list mirrors what kubectl does and works everywhere.
    const res = await this.raw(url, {
      accept: 'text/plain, */*;q=0.8',
      signal: options.signal,
    });
    if (res.status < 200 || res.status >= 300) throw new K8sError(res.status, res.text);
    return res.text;
  }

  // Watch a resource collection. Emits parsed WatchEvent<T> for each line
  // received on the stream. The caller is responsible for the initial LIST
  // (so it has a resourceVersion to start from) and for reconnecting when
  // the stream closes/errors — see useWatchedList for the full pattern.
  watch<T = K8sObject>(
    rdef: { apiGroup: string; apiVersion: string; plural: string; namespaced: boolean },
    options: {
      namespace?: string;
      resourceVersion: string;
      labelSelector?: string;
      fieldSelector?: string;
      allowBookmarks?: boolean;
      // K8s caps watches at this many seconds (default 300 if omitted client-side).
      timeoutSeconds?: number;
    },
    cb: {
      onEvent: (e: WatchEvent<T>) => void;
      onError?: (err: { name?: string; message: string; status?: number }) => void;
      onDone?: (info: { cancelled: boolean }) => void;
    },
  ): StreamHandle {
    const path = this.resourcePath({
      apiGroup: rdef.apiGroup,
      apiVersion: rdef.apiVersion,
      plural: rdef.plural,
      namespace: rdef.namespaced ? options.namespace : undefined,
    });
    const url = this.url(path, {
      watch: 'true',
      resourceVersion: options.resourceVersion || undefined,
      labelSelector: options.labelSelector,
      fieldSelector: options.fieldSelector,
      allowWatchBookmarks: options.allowBookmarks === false ? undefined : 'true',
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });

    const parser = makeWatchParser<T>(
      (e) => cb.onEvent(e),
      (line, err) =>
        log({
          kind: 'error',
          transport: 'native',
          method: 'WATCH',
          url,
          ms: 0,
          name: 'WatchParseError',
          message: `Failed to parse watch line (${line.length} chars): ${
            (err as Error)?.message ?? String(err)
          }`,
        }),
    );

    return nativeStream(
      {
        url,
        method: 'GET',
        headers: this.authHeaders(),
        pkcs12Base64: this.conn.pkcs12Base64,
        pkcs12Password: this.conn.pkcs12Password,
        caBundlesDerBase64: this.conn.caBundlesDerBase64,
        insecureSkipTLSVerify: this.conn.insecureSkipTLSVerify,
        tlsServerName: this.conn.tlsServerName,
        timeoutSeconds: (options.timeoutSeconds ?? 300) + 30,
      },
      {
        onChunk: parser,
        onError: cb.onError,
        onDone: cb.onDone,
      },
    );
  }

  // Live-tail pod logs. The server keeps the HTTP connection open (?follow=true)
  // and pushes lines as the container emits them. Returns a handle with `stop()`
  // to close the connection. The callbacks fire on the JS thread.
  podLogsStream(
    namespace: string,
    name: string,
    options: {
      container?: string;
      tailLines?: number;
      timestamps?: boolean;
      sinceSeconds?: number;
    },
    cb: {
      onChunk: (text: string) => void;
      onError?: (err: { name?: string; message: string; status?: number }) => void;
      onDone?: (info: { cancelled: boolean }) => void;
    },
  ): StreamHandle {
    const url = this.url(`/api/v1/namespaces/${namespace}/pods/${name}/log`, {
      container: options.container,
      tailLines: options.tailLines ?? 500,
      timestamps: options.timestamps ? 'true' : undefined,
      sinceSeconds: options.sinceSeconds,
      follow: 'true',
    });
    return nativeStream(
      {
        url,
        method: 'GET',
        headers: this.authHeaders({ Accept: 'text/plain, */*;q=0.8' }),
        pkcs12Base64: this.conn.pkcs12Base64,
        pkcs12Password: this.conn.pkcs12Password,
        caBundlesDerBase64: this.conn.caBundlesDerBase64,
        insecureSkipTLSVerify: this.conn.insecureSkipTLSVerify,
        tlsServerName: this.conn.tlsServerName,
        timeoutSeconds: 600,
      },
      cb,
    );
  }

  // Metrics — provided by metrics-server. Throws K8sError(404) when not installed,
  // which callers should treat as "metrics unavailable" rather than a hard failure.
  async listNodeMetrics(signal?: AbortSignal): Promise<MetricsList<NodeMetrics>> {
    return this.jsonOrThrow(
      await this.raw('/apis/metrics.k8s.io/v1beta1/nodes', { signal }),
    );
  }
  async getNodeMetrics(name: string, signal?: AbortSignal): Promise<NodeMetrics> {
    return this.jsonOrThrow(
      await this.raw(`/apis/metrics.k8s.io/v1beta1/nodes/${name}`, { signal }),
    );
  }
  async listPodMetrics(namespace?: string, signal?: AbortSignal): Promise<MetricsList<PodMetrics>> {
    const path = namespace
      ? `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`
      : '/apis/metrics.k8s.io/v1beta1/pods';
    return this.jsonOrThrow(await this.raw(path, { signal }));
  }
  async getPodMetrics(
    namespace: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<PodMetrics> {
    return this.jsonOrThrow(
      await this.raw(
        `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${name}`,
        { signal },
      ),
    );
  }

  // Exec into a pod via the v4.channel.k8s.io WebSocket subprotocol.
  // Channels:
  //   0 = stdin (client → server)
  //   1 = stdout (server → client)
  //   2 = stderr (server → client)
  //   3 = error (server → client, JSON Status on exit)
  //   4 = resize (client → server, JSON {"Width":N,"Height":N})
  podExec(
    namespace: string,
    name: string,
    options: {
      container?: string;
      command: string[];
      stdin?: boolean;
      stdout?: boolean;
      stderr?: boolean;
      tty?: boolean;
    },
    cb: {
      onStdout?: (data: Uint8Array) => void;
      onStderr?: (data: Uint8Array) => void;
      onExit?: (status: string) => void;
      onOpen?: () => void;
      onClose?: (info: { code: number; reason: string }) => void;
      onError?: (err: { name?: string; message: string; status?: number }) => void;
    },
  ): ExecHandle {
    const params: Record<string, string | undefined> = {
      stdin: (options.stdin ?? true) ? 'true' : 'false',
      stdout: (options.stdout ?? true) ? 'true' : 'false',
      stderr: (options.stderr ?? true) ? 'true' : 'false',
      tty: (options.tty ?? true) ? 'true' : 'false',
      container: options.container,
    };
    // K8s wants ?command=... repeated; build the query manually.
    const base = this.url(`/api/v1/namespaces/${namespace}/pods/${name}/exec`, params);
    const cmdQuery = options.command
      .map((c) => `command=${encodeURIComponent(c)}`)
      .join('&');
    const wssUrl = (base + (base.includes('?') ? '&' : '?') + cmdQuery).replace(
      /^https?:/,
      base.startsWith('https') ? 'wss:' : 'ws:',
    );

    // Auth only, no Accept — K8s exec returns 406 when Accept: application/json
    // is present because the endpoint upgrades to WS, it doesn't serve JSON.
    const wsHeaders = this.credentialHeaders();
    log({ kind: 'request', transport: 'native', method: 'WS', url: wssUrl, headers: redact(wsHeaders) });
    const ws = nativeWebSocket(
      {
        url: wssUrl,
        headers: wsHeaders,
        // K8s 1.30+ added v5 (adds stdin EOF semantics); 1.32+ may prefer it.
        // Offer v5 first, fall back to v4. Both share the same channel-byte
        // framing for stdin/stdout/stderr so the demux code is unchanged.
        protocols: ['v5.channel.k8s.io', 'v4.channel.k8s.io'],
        pkcs12Base64: this.conn.pkcs12Base64,
        pkcs12Password: this.conn.pkcs12Password,
        caBundlesDerBase64: this.conn.caBundlesDerBase64,
        insecureSkipTLSVerify: this.conn.insecureSkipTLSVerify,
        tlsServerName: this.conn.tlsServerName,
      },
      {
        onOpen: (proto) => {
          log({ kind: 'ws-open', url: wssUrl, protocol: proto });
          cb.onOpen?.();
        },
        onBinary: (b64) => {
          const buf = base64ToBytes(b64);
          if (buf.length === 0) return;
          const channel = buf[0];
          const payload = buf.subarray(1);
          switch (channel) {
            case 1: cb.onStdout?.(payload); break;
            case 2: cb.onStderr?.(payload); break;
            case 3: cb.onExit?.(bytesToString(payload)); break;
            default: break; // unknown channel; ignore
          }
        },
        onClose: (info) => {
          log({ kind: 'ws-close', url: wssUrl, code: info.code, reason: info.reason });
          cb.onClose?.(info);
        },
        onError: (err) => {
          log({
            kind: 'ws-error',
            url: wssUrl,
            name: err.name,
            message: err.message,
            status: err.status,
          });
          cb.onError?.(err);
        },
      },
    );

    return {
      write(input: string | Uint8Array) {
        const bytes = typeof input === 'string' ? stringToBytes(input) : input;
        const framed = new Uint8Array(bytes.length + 1);
        framed[0] = 0; // stdin channel
        framed.set(bytes, 1);
        void ws.sendBinary(bytesToBase64(framed));
      },
      resize(cols: number, rows: number) {
        const body = JSON.stringify({ Width: cols, Height: rows });
        const bytes = stringToBytes(body);
        const framed = new Uint8Array(bytes.length + 1);
        framed[0] = 4; // resize channel
        framed.set(bytes, 1);
        void ws.sendBinary(bytesToBase64(framed));
      },
      close() {
        ws.close();
      },
    };
  }

  async ping(signal?: AbortSignal): Promise<{ gitVersion: string; platform: string }> {
    return this.jsonOrThrow(await this.raw('/version', { signal }));
  }

  async coreAPIResources(signal?: AbortSignal): Promise<APIResourceList> {
    return this.jsonOrThrow(await this.raw('/api/v1', { signal }));
  }
  async apiGroups(signal?: AbortSignal): Promise<APIGroupList> {
    return this.jsonOrThrow(await this.raw('/apis', { signal }));
  }
  async groupResources(groupVersion: string, signal?: AbortSignal): Promise<APIResourceList> {
    return this.jsonOrThrow(await this.raw(`/apis/${groupVersion}`, { signal }));
  }
}
