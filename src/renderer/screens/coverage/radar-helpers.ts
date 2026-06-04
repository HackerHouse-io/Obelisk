import { useEffect, useRef, useState } from 'react';

/** Tween duration for the radar axes growing to their new values, in ms. */
export const RADAR_TWEEN_MS = 600;

/** Truncate an axis label to `max` chars with an ellipsis (full text via title). */
export function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return label.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Tween from the previously-rendered values to `target` over RADAR_TWEEN_MS.
 * Returns an array that mutates each animation frame, so the radar animates
 * the "axis growing outward after a run" effect. Shared by the test-coverage
 * and UX-coverage radars.
 */
export function useAnimatedValues(target: number[]): number[] {
  const [values, setValues] = useState<number[]>(() => target.map(() => 0));
  const prevRef = useRef<number[]>(values);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = padTo(prevRef.current, target.length, 0);
    const start = performance.now();
    function step(now: number): void {
      const t = Math.min(1, (now - start) / RADAR_TWEEN_MS);
      const eased = easeOutCubic(t);
      const next = target.map((tv, i) => {
        const fv = from[i] ?? 0;
        return fv + (tv - fv) * eased;
      });
      setValues(next);
      prevRef.current = next;
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else rafRef.current = null;
    }
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // Re-run when the target signature changes — key on the joined values so an
    // in-place mutation that keeps the same array identity also fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.join('|')]);

  return values;
}

function padTo(arr: number[], len: number, fill: number): number[] {
  if (arr.length === len) return arr;
  const out = arr.slice(0, len);
  while (out.length < len) out.push(fill);
  return out;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}
