// K8s watch protocol: HTTP/1.1 chunked-transfer stream of JSON-Lines events.
// https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes
//
// Each line is a serialized WatchEvent:
//   { type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR", object: <K8sObject> }
//
// We split on \n in the chunked text and JSON.parse each non-empty line.

import type { K8sObject } from './types';

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';

export type WatchEvent<T = K8sObject> = {
  type: WatchEventType;
  // For BOOKMARK the object is a partial K8sObject with only metadata.resourceVersion.
  // For ERROR it is a Status object (see K8s api errors).
  object: T;
};

// Returns a parser closure: feed it text chunks, get back complete events.
// Bad/incomplete lines are buffered; malformed JSON is reported via onError.
export function makeWatchParser<T = K8sObject>(
  onEvent: (e: WatchEvent<T>) => void,
  onError?: (line: string, err: unknown) => void,
): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line) as WatchEvent<T>;
        onEvent(evt);
      } catch (e) {
        onError?.(line, e);
      }
    }
  };
}

// Canonical key for tracking items. Prefer UID (cluster-unique, stable across
// renames) and fall back to ns/name for objects that haven't been assigned a
// UID yet (rare — usually only seen on injected/builder K8sObjects).
export function objectKey(o: K8sObject): string {
  return o.metadata.uid ?? `${o.metadata.namespace ?? ''}/${o.metadata.name}`;
}
