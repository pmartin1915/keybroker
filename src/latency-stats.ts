import type { LatencyStats } from "./store-types.js";

/**
 * Phase 3.7: compute p50/p95 over two parallel sample arrays. The arrays
 * are independent (TPOT can be undefined on a call that still has a
 * valid TTFT — single-byte / zero-output responses), so each percentile
 * is computed against its own sample size.
 *
 * Method: nearest-rank percentile (NIST definition). For a sorted array
 * of length n, the p-th percentile sits at index `ceil(p/100 * n) - 1`
 * (clamped to [0, n-1]). Choices:
 *   - Nearest-rank instead of linear interpolation: one less arithmetic
 *     surprise when p95 falls between two integers; the result is
 *     always an observed value the operator can cross-reference in the
 *     audit log.
 *   - We sort in-place. Callers pass arrays they own; if a future
 *     caller wants to retain ordering, copy first.
 *
 * `sampleCount` is the TTFT sample size — it's the canonical "did this
 * window have data?" signal. Distinguishing TTFT-only-windows vs
 * TPOT-only-windows is not currently surfaced; if it becomes useful,
 * add `tpotSampleCount` as a separate field rather than overloading.
 */
export function computeLatencyStats(
  ttfts: number[],
  tpots: number[],
): LatencyStats {
  const stats: LatencyStats = { sampleCount: ttfts.length };
  if (ttfts.length > 0) {
    ttfts.sort((a, b) => a - b);
    stats.p50TtftMs = percentile(ttfts, 50);
    stats.p95TtftMs = percentile(ttfts, 95);
  }
  if (tpots.length > 0) {
    tpots.sort((a, b) => a - b);
    stats.p50TpotMsAvg = percentile(tpots, 50);
    stats.p95TpotMsAvg = percentile(tpots, 95);
  }
  return stats;
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0; // caller guards this
  const rank = Math.ceil((p / 100) * n) - 1;
  const idx = Math.max(0, Math.min(n - 1, rank));
  return sorted[idx]!;
}
