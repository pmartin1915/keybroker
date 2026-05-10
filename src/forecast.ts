/**
 * Phase 3.5: linear-regression burn forecast.
 *
 * Pure module — no store, no time, no I/O. The store layer feeds in a
 * sparse list of `{day, usd}` (one per UTC date that had priced spend),
 * `buildDenseCumulativeSeries` densifies it (filling 0-spend days so the
 * regression sees the full window), and `forecastBurn` runs the
 * least-squares fit and projects when the cumulative line crosses a cap.
 *
 * Why density matters: least squares is sensitive to which points are
 * included. If a token spent on day 0 and day 5 only, the sparse pair
 * fits a line that says "0.20 USD/day on average across both days".
 * The dense cumulative-with-flat-segments fits the same slope but
 * assigns weight to the days in between — which is the FinOps story
 * the dashboard cares about ("burn rate over the window") and not the
 * "slope between two arbitrary points" story. The two coincide when
 * spend is uniform; they diverge under bursty traffic. The dense form
 * is what we want.
 */

/**
 * Solve the closed-form least-squares slope + intercept for a series of
 * (x, y) points. Pure math; no domain assumptions.
 *
 *   slope     = (n·Σxy - Σx·Σy) / (n·Σx² - (Σx)²)
 *   intercept = (Σy - slope·Σx) / n
 *
 * Edge cases:
 *  - 0 points → {0, 0}. Caller should treat as "no forecast available".
 *  - 1 point  → {0, y₀}. A single point has no slope; intercept = the
 *               point's value so the constant line still passes through it.
 *  - All x identical (denominator zero) → {0, mean(y)}. Same posture as
 *    1 point: no slope to recover.
 */
export function leastSquares(
  points: ReadonlyArray<{ x: number; y: number }>,
): { slope: number; intercept: number } {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: points[0]!.y };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

export interface BurnForecast {
  /** USD/day burn rate from the regression. 0 when fewer than 2 points. */
  slopeUsdPerDay: number;
  /** Regression intercept at dayIndex=0. Mostly diagnostic. */
  interceptUsd: number;
  /** Latest cumulative spend in the series. 0 for empty series. */
  currentUsd: number;
  /**
   * Days from `now` until cumulative spend hits `capUsd`. Undefined when:
   *  - no cap was supplied,
   *  - slope <= 0 (no breach projected — inert or refunding),
   *  - the series is empty (no signal to project from).
   * 0 means "already at or past the cap".
   */
  daysUntilCap?: number;
  /** ISO timestamp of the projected breach. Undefined whenever daysUntilCap is. */
  projectedCapBreachDate?: string;
}

export interface ForecastBurnOptions {
  /** Dense daily cumulative series. dayIndex 0 = window start, monotonic. */
  series: ReadonlyArray<{ dayIndex: number; cumUsd: number }>;
  /** Cap to project against. Omit for "burn rate only" (e.g. tag leaderboard). */
  capUsd?: number;
  /** Reference clock for `projectedCapBreachDate`. Tests inject a fixed Date. */
  now?: Date;
}

export function forecastBurn(opts: ForecastBurnOptions): BurnForecast {
  const { series, capUsd, now = new Date() } = opts;
  const { slope, intercept } = leastSquares(
    series.map((p) => ({ x: p.dayIndex, y: p.cumUsd })),
  );
  const currentUsd =
    series.length > 0 ? series[series.length - 1]!.cumUsd : 0;
  const out: BurnForecast = {
    slopeUsdPerDay: slope,
    interceptUsd: intercept,
    currentUsd,
  };
  if (capUsd === undefined || !Number.isFinite(capUsd)) return out;
  if (series.length === 0) return out;
  if (currentUsd >= capUsd) {
    out.daysUntilCap = 0;
    out.projectedCapBreachDate = now.toISOString();
    return out;
  }
  if (slope <= 0) return out;
  const days = (capUsd - currentUsd) / slope;
  out.daysUntilCap = days;
  out.projectedCapBreachDate = new Date(
    now.getTime() + days * 86_400_000,
  ).toISOString();
  return out;
}

/**
 * Convert a sparse per-day spend series into a dense day-indexed
 * cumulative series. Days outside the window are dropped; days
 * inside the window with no spend get a 0 increment (so the cumulative
 * line stays flat across them, which is what the regression should see).
 *
 *   sparse        = [{day:"2026-05-01", usd:1.0}, {day:"2026-05-03", usd:2.0}]
 *   startDay/endDay = "2026-05-01" / "2026-05-04"
 *   dense         = [{0,1.0},{1,1.0},{2,3.0},{3,3.0}]
 *
 * `day` is parsed as `YYYY-MM-DD` UTC midnight. The store layer extracts
 * it from `ts` via `substr(ts, 1, 10)` (SQLite) or `ts.slice(0, 10)`
 * (JSON), so the format is stable across both backends.
 */
export function buildDenseCumulativeSeries(opts: {
  sparse: ReadonlyArray<{ day: string; usd: number }>;
  startDay: string;
  endDay: string;
}): Array<{ dayIndex: number; cumUsd: number }> {
  const startMs = Date.parse(`${opts.startDay}T00:00:00Z`);
  const endMs = Date.parse(`${opts.endDay}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const totalDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  const incremental = new Array<number>(totalDays).fill(0);
  for (const p of opts.sparse) {
    const dms = Date.parse(`${p.day}T00:00:00Z`);
    if (!Number.isFinite(dms)) continue;
    const idx = Math.round((dms - startMs) / 86_400_000);
    if (idx < 0 || idx >= totalDays) continue;
    incremental[idx] = (incremental[idx] ?? 0) + p.usd;
  }
  let cum = 0;
  const out: Array<{ dayIndex: number; cumUsd: number }> = [];
  for (let i = 0; i < totalDays; i++) {
    cum += incremental[i] ?? 0;
    out.push({ dayIndex: i, cumUsd: cum });
  }
  return out;
}

/**
 * Format a date as `YYYY-MM-DD` in UTC. Used by routes/CLI to compute
 * window endpoints from a `since` shorthand. Kept here so forecast.ts
 * is the single source of truth for the YYYY-MM-DD convention shared
 * with `buildDenseCumulativeSeries`.
 */
export function utcDayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
