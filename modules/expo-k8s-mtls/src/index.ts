import { requireNativeModule } from 'expo-modules-core';

export type K8sNativeRequest = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  pkcs12Base64?: string;
  pkcs12Password?: string;
  caBundlesDerBase64?: string[];
  insecureSkipTLSVerify?: boolean;
  tlsServerName?: string;
  timeoutSeconds?: number;
};

export type K8sNativeResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

type K8sChunkEvent = { streamId: string; data: string };
type K8sDoneEvent = { streamId: string; cancelled: boolean };
type K8sErrorEvent = {
  streamId: string;
  name?: string;
  message: string;
  status?: number;
};

type Sub = { remove(): void };

export type K8sWsOptions = {
  url: string;
  headers?: Record<string, string>;
  protocols?: string[];
  pkcs12Base64?: string;
  pkcs12Password?: string;
  caBundlesDerBase64?: string[];
  insecureSkipTLSVerify?: boolean;
  tlsServerName?: string;
};

type WsMessageEvent = {
  wsId: string;
  kind: 'text' | 'binary';
  // For binary the data is base64-encoded.
  data: string;
};
type WsOpenEvent = { wsId: string; protocol: string };
type WsCloseEvent = { wsId: string; code: number; reason: string };
type WsErrorEvent = { wsId: string; name?: string; message: string; status?: number };

type ExpoK8sMtls = {
  request(opts: K8sNativeRequest): Promise<K8sNativeResponse>;
  startStream(opts: K8sNativeRequest): string;
  cancelStream(streamId: string): void;
  startWebSocket(opts: K8sWsOptions): string;
  sendWebSocketBinary(wsId: string, base64: string): Promise<boolean>;
  sendWebSocketText(wsId: string, text: string): Promise<boolean>;
  closeWebSocket(wsId: string): void;
  addListener(name: string, fn: (e: any) => void): Sub;
};

const native = requireNativeModule<ExpoK8sMtls>('ExpoK8sMtls');

export async function nativeRequest(opts: K8sNativeRequest): Promise<K8sNativeResponse> {
  return native.request(opts);
}

export type StreamHandle = { stop(): void };
export type StreamCallbacks = {
  onChunk: (data: string) => void;
  onDone?: (info: { cancelled: boolean }) => void;
  onError?: (err: { name?: string; message: string; status?: number }) => void;
};

// Start a streaming HTTP request. Returns a handle with stop().
// Chunks are delivered to onChunk in order; on completion or error, the relevant
// callback fires once and listeners are released automatically.
export function nativeStream(opts: K8sNativeRequest, cb: StreamCallbacks): StreamHandle {
  const streamId = native.startStream(opts);
  const subs: Sub[] = [];
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    for (const s of subs) s.remove();
  };

  subs.push(
    native.addListener('onK8sChunk', (e: K8sChunkEvent) => {
      if (e.streamId === streamId && !settled) cb.onChunk(e.data);
    }),
    native.addListener('onK8sDone', (e: K8sDoneEvent) => {
      if (e.streamId !== streamId) return;
      cb.onDone?.({ cancelled: !!e.cancelled });
      cleanup();
    }),
    native.addListener('onK8sError', (e: K8sErrorEvent) => {
      if (e.streamId !== streamId) return;
      cb.onError?.({ name: e.name, message: e.message, status: e.status });
      cleanup();
    }),
  );

  return {
    stop() {
      if (settled) return;
      native.cancelStream(streamId);
      cleanup();
    },
  };
}

// MARK: WebSocket

export type WsHandle = {
  sendBinary(base64: string): Promise<void>;
  sendText(text: string): Promise<void>;
  close(): void;
};

export type WsCallbacks = {
  onOpen?: (protocol: string) => void;
  onBinary?: (base64: string) => void;
  onText?: (text: string) => void;
  onClose?: (info: { code: number; reason: string }) => void;
  onError?: (err: { name?: string; message: string; status?: number }) => void;
};

export function nativeWebSocket(opts: K8sWsOptions, cb: WsCallbacks): WsHandle {
  const wsId = native.startWebSocket(opts);
  const subs: Sub[] = [];
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    for (const s of subs) s.remove();
  };

  subs.push(
    native.addListener('onK8sWsOpen', (e: WsOpenEvent) => {
      if (e.wsId === wsId) cb.onOpen?.(e.protocol);
    }),
    native.addListener('onK8sWsMessage', (e: WsMessageEvent) => {
      if (e.wsId !== wsId) return;
      if (e.kind === 'binary') cb.onBinary?.(e.data);
      else cb.onText?.(e.data);
    }),
    native.addListener('onK8sWsClose', (e: WsCloseEvent) => {
      if (e.wsId !== wsId) return;
      cb.onClose?.({ code: e.code, reason: e.reason });
      cleanup();
    }),
    native.addListener('onK8sWsError', (e: WsErrorEvent) => {
      if (e.wsId !== wsId) return;
      cb.onError?.({ name: e.name, message: e.message, status: e.status });
      cleanup();
    }),
  );

  return {
    async sendBinary(base64: string) {
      if (closed) return;
      // Send can race with close — swallow rejection if the socket has died
      // since the caller decided to send. The error path is already surfaced
      // via onError / onClose, so re-throwing here is noise.
      try {
        await native.sendWebSocketBinary(wsId, base64);
      } catch (e: any) {
        if (closed) return;
        throw e;
      }
    },
    async sendText(text: string) {
      if (closed) return;
      try {
        await native.sendWebSocketText(wsId, text);
      } catch (e: any) {
        if (closed) return;
        throw e;
      }
    },
    close() {
      if (closed) return;
      native.closeWebSocket(wsId);
      cleanup();
    },
  };
}

export default native;
