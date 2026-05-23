// Lightweight diagnostics: ring-buffer of request/response/error events plus subscribers.
// Mirrored to console.log so the user can watch them in Metro logs / Hermes debugger.

export type DiagEvent =
  | {
      kind: 'request';
      transport: 'fetch' | 'native';
      method: string;
      url: string;
      headers: Record<string, string>;
      ts?: number;
    }
  | {
      kind: 'response';
      transport: 'fetch' | 'native';
      method: string;
      url: string;
      status: number;
      ms: number;
      bodyPreview: string;
      ts?: number;
    }
  | {
      kind: 'error';
      transport: 'fetch' | 'native';
      method: string;
      url: string;
      ms: number;
      name?: string;
      message: string;
      code?: string;
      ts?: number;
    }
  | { kind: 'ws-open'; url: string; protocol?: string; ts?: number }
  | { kind: 'ws-close'; url: string; code: number; reason: string; ts?: number }
  | {
      kind: 'ws-error';
      url: string;
      name?: string;
      message: string;
      status?: number;
      ts?: number;
    };

const MAX_EVENTS = 200;
const buffer: DiagEvent[] = [];
const subscribers = new Set<(e: DiagEvent) => void>();

export function log(event: DiagEvent): void {
  const e = { ...event, ts: Date.now() } as DiagEvent;
  buffer.push(e);
  if (buffer.length > MAX_EVENTS) buffer.shift();
  for (const s of subscribers) s(e);
  if (__DEV__) {
    // Two lines makes long URLs survive line wrapping in Metro.
    if (e.kind === 'request') {
      // eslint-disable-next-line no-console
      console.log(`[k8s] → ${e.method} ${e.url} (${e.transport})`);
    } else if (e.kind === 'response') {
      // eslint-disable-next-line no-console
      console.log(
        `[k8s] ← ${e.status} ${e.method} ${e.url} (${e.ms}ms)${
          e.status >= 400 ? `  body: ${e.bodyPreview}` : ''
        }`,
      );
    } else if (e.kind === 'ws-open') {
      // eslint-disable-next-line no-console
      console.log(`[k8s] ⇡ WS open ${e.url} (proto=${e.protocol ?? ''})`);
    } else if (e.kind === 'ws-close') {
      // eslint-disable-next-line no-console
      console.log(`[k8s] ⇣ WS close ${e.url} (${e.code} ${e.reason})`);
    } else if (e.kind === 'ws-error') {
      // eslint-disable-next-line no-console
      console.warn(
        `[k8s] ✗ WS ${e.url}${e.status ? ` (HTTP ${e.status})` : ''} ${e.name ?? ''}: ${e.message}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[k8s] ✗ ${e.method} ${e.url} (${e.ms}ms) ${e.name ?? ''}: ${e.message}`,
      );
    }
  }
}

export function getRecentEvents(): DiagEvent[] {
  return [...buffer];
}

export function subscribe(fn: (e: DiagEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function clearEvents(): void {
  buffer.length = 0;
}

// Strip sensitive header values for logs.
export function redact(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/authorization|cookie/i.test(k)) {
      const suffix = v.length > 12 ? `…${v.slice(-6)} (${v.length} chars)` : '<redacted>';
      out[k] = suffix;
    } else {
      out[k] = v;
    }
  }
  return out;
}
