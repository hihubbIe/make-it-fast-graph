/** Summary statistics for per-frame timing series. NaN entries (no sample) are ignored. */

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const EMPTY: Summary = { n: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };

export function summarize(values: ArrayLike<number>): Summary {
  const v: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = values[i]!;
    if (!Number.isNaN(x)) v.push(x);
  }
  if (v.length === 0) return EMPTY;
  v.sort((a, b) => a - b);
  let sum = 0;
  for (const x of v) sum += x;
  return {
    n: v.length,
    mean: sum / v.length,
    p50: quantile(v, 0.5),
    p95: quantile(v, 0.95),
    p99: quantile(v, 0.99),
    max: v[v.length - 1]!,
  };
}

/** Nearest-rank quantile over a sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}
