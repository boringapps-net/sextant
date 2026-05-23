// Parse Kubernetes resource quantity strings.
// Spec: https://kubernetes.io/docs/reference/kubernetes-api/common-definitions/quantity/
//
// We cover the cases that show up in real metrics/capacity payloads:
//   CPU         "100m"  "0.5"  "2"  "2500m"
//   Memory      "1024"  "512Ki"  "1Mi"  "2Gi"  "1e9"
//   Storage     same units as memory
// The result is always a Number (cores for CPU, bytes for memory).

const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  '': 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

export function parseQuantity(input: string | number | undefined | null): number {
  if (input == null) return 0;
  if (typeof input === 'number') return input;
  const s = String(input).trim();
  if (!s) return 0;

  // Match: optional sign, digits/decimal, optional exponent, optional suffix.
  // Suffix is one of the binary (Ki/Mi/...) or decimal (n/u/m/k/M/G/...).
  const m = /^(-?\d+(?:\.\d+)?)(?:[eE]([+-]?\d+))?\s*([a-zA-Z]+)?$/.exec(s);
  if (!m) return Number(s) || 0;
  const base = parseFloat(m[1]);
  const exp = m[2] ? parseInt(m[2], 10) : 0;
  const suffix = m[3] ?? '';
  const num = base * Math.pow(10, exp);
  if (suffix in BINARY) return num * BINARY[suffix];
  if (suffix in DECIMAL) return num * DECIMAL[suffix];
  return num; // unknown suffix → return the numeric part
}

// Format bytes (1024-based) with a sensible unit.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : n.toFixed(0)} ${units[i]}`;
}

// Format CPU cores. Show milli-cores when < 1, otherwise cores.
export function formatCores(cores: number): string {
  if (!Number.isFinite(cores) || cores <= 0) return '0';
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return cores < 10 ? cores.toFixed(2) : cores.toFixed(1);
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(0)}%`;
}
