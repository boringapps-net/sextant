import { useEffect, useRef, useState } from 'react';

export type Point = { t: number; v: number };

// Polls `fetcher` every intervalMs and keeps the last `maxSamples` points.
// Returns the current series, the latest fetch error (if any), and a manual refresh.
// The fetcher receives an AbortSignal and should reject on abort — we'll ignore
// AbortError values without spamming setState.
export function useTimeSeries(
  fetcher: (signal: AbortSignal) => Promise<number | null>,
  options: { intervalMs?: number; maxSamples?: number } = {},
): { points: Point[]; error: string | null } {
  const { intervalMs = 5000, maxSamples = 60 } = options;
  const [points, setPoints] = useState<Point[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const fnRef = useRef(fetcher);
  fnRef.current = fetcher;

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;

    async function tick() {
      ctrl?.abort();
      ctrl = new AbortController();
      try {
        const v = await fnRef.current(ctrl.signal);
        if (!mounted.current) return;
        if (v == null || !Number.isFinite(v)) {
          // Don't push null into the series — leave a gap by holding the last value
          // (or: setError, keep going). For simplicity we just skip the sample.
        } else {
          const sample: Point = { t: Date.now(), v };
          setPoints((prev) => {
            const next = prev.length >= maxSamples ? prev.slice(1) : prev.slice();
            next.push(sample);
            return next;
          });
        }
        setError(null);
      } catch (e: any) {
        if (e?.name === 'AbortError' || !mounted.current) return;
        setError(e?.message ?? String(e));
      } finally {
        if (mounted.current) timer = setTimeout(tick, intervalMs);
      }
    }
    void tick();
    return () => {
      mounted.current = false;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [intervalMs, maxSamples]);

  return { points, error };
}
