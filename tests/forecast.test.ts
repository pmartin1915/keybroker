import { describe, it, expect } from "vitest";
import {
  buildDenseCumulativeSeries,
  forecastBurn,
  leastSquares,
  utcDayOf,
} from "../src/forecast.js";

describe("leastSquares", () => {
  it("recovers slope and intercept of a clean line y = 2x + 3", () => {
    // Hand-computed reference. n=5, Σx=10, Σy=35, Σxy=90, Σx²=30.
    // slope = (5·90 − 10·35)/(5·30 − 100) = 100/50 = 2
    // intercept = (35 − 2·10)/5 = 3
    const r = leastSquares([
      { x: 0, y: 3 },
      { x: 1, y: 5 },
      { x: 2, y: 7 },
      { x: 3, y: 9 },
      { x: 4, y: 11 },
    ]);
    expect(r.slope).toBeCloseTo(2, 9);
    expect(r.intercept).toBeCloseTo(3, 9);
  });

  it("recovers a fractional slope y = 0.5x", () => {
    // Σx=10, Σy=5, Σxy=15, Σx²=30 → slope=0.5, intercept=0.
    const r = leastSquares([
      { x: 0, y: 0 },
      { x: 1, y: 0.5 },
      { x: 2, y: 1 },
      { x: 3, y: 1.5 },
      { x: 4, y: 2 },
    ]);
    expect(r.slope).toBeCloseTo(0.5, 9);
    expect(r.intercept).toBeCloseTo(0, 9);
  });

  it("returns 0/0 for an empty input", () => {
    expect(leastSquares([])).toEqual({ slope: 0, intercept: 0 });
  });

  it("returns slope=0, intercept=y for a single point", () => {
    expect(leastSquares([{ x: 7, y: 1.25 }])).toEqual({
      slope: 0,
      intercept: 1.25,
    });
  });

  it("returns slope=0, intercept=mean(y) when all x are identical", () => {
    // All four points share x=3 — denom is 0, can't recover slope.
    const r = leastSquares([
      { x: 3, y: 1 },
      { x: 3, y: 3 },
      { x: 3, y: 5 },
      { x: 3, y: 7 },
    ]);
    expect(r.slope).toBe(0);
    expect(r.intercept).toBe(4);
  });

  it("handles a noisy series — best-fit slope falls between extremes", () => {
    // 14 daily samples, true slope ~1.0, ±0.2 noise. Verify slope is
    // within tolerance instead of exact, since noise breaks closed-form
    // identities. The 14-day window matches the plan's reference series.
    const points = Array.from({ length: 14 }, (_, i) => ({
      x: i,
      y: i + (i % 3 === 0 ? 0.2 : i % 3 === 1 ? -0.2 : 0),
    }));
    const r = leastSquares(points);
    expect(r.slope).toBeGreaterThan(0.95);
    expect(r.slope).toBeLessThan(1.05);
  });
});

describe("buildDenseCumulativeSeries", () => {
  it("fills 0-spend days and cumsums correctly", () => {
    // Spend on day 0 ($1) and day 2 ($2) only. Days 1 and 3 have no
    // spend; cumulative should stay flat across them.
    const dense = buildDenseCumulativeSeries({
      sparse: [
        { day: "2026-05-01", usd: 1.0 },
        { day: "2026-05-03", usd: 2.0 },
      ],
      startDay: "2026-05-01",
      endDay: "2026-05-04",
    });
    expect(dense).toEqual([
      { dayIndex: 0, cumUsd: 1.0 },
      { dayIndex: 1, cumUsd: 1.0 },
      { dayIndex: 2, cumUsd: 3.0 },
      { dayIndex: 3, cumUsd: 3.0 },
    ]);
  });

  it("emits a single 0-cum point when start == end and no spend", () => {
    const dense = buildDenseCumulativeSeries({
      sparse: [],
      startDay: "2026-05-10",
      endDay: "2026-05-10",
    });
    expect(dense).toEqual([{ dayIndex: 0, cumUsd: 0 }]);
  });

  it("drops sparse rows outside the window", () => {
    const dense = buildDenseCumulativeSeries({
      sparse: [
        { day: "2026-04-30", usd: 99.0 },
        { day: "2026-05-01", usd: 1.0 },
        { day: "2026-05-03", usd: 99.0 },
      ],
      startDay: "2026-05-01",
      endDay: "2026-05-02",
    });
    expect(dense).toEqual([
      { dayIndex: 0, cumUsd: 1.0 },
      { dayIndex: 1, cumUsd: 1.0 },
    ]);
  });

  it("returns [] when endDay precedes startDay", () => {
    expect(
      buildDenseCumulativeSeries({
        sparse: [],
        startDay: "2026-05-10",
        endDay: "2026-05-01",
      }),
    ).toEqual([]);
  });

  it("aggregates same-day duplicates", () => {
    // Two sparse rows on the same day — exercising the += branch.
    const dense = buildDenseCumulativeSeries({
      sparse: [
        { day: "2026-05-01", usd: 0.5 },
        { day: "2026-05-01", usd: 0.25 },
      ],
      startDay: "2026-05-01",
      endDay: "2026-05-01",
    });
    expect(dense).toEqual([{ dayIndex: 0, cumUsd: 0.75 }]);
  });
});

describe("forecastBurn", () => {
  // Fixed clock so projectedCapBreachDate is deterministic.
  const NOW = new Date("2026-05-10T00:00:00Z");

  it("returns zeros when no series and no cap", () => {
    const r = forecastBurn({ series: [] });
    expect(r.slopeUsdPerDay).toBe(0);
    expect(r.interceptUsd).toBe(0);
    expect(r.currentUsd).toBe(0);
    expect(r.daysUntilCap).toBeUndefined();
    expect(r.projectedCapBreachDate).toBeUndefined();
  });

  it("returns no projection when capUsd is supplied but series is empty", () => {
    // No spend signal → can't claim "0 days to cap" or "never". The
    // route renders this as "no forecast" in the dashboard.
    const r = forecastBurn({ series: [], capUsd: 10, now: NOW });
    expect(r.daysUntilCap).toBeUndefined();
    expect(r.projectedCapBreachDate).toBeUndefined();
  });

  it("projects daysUntilCap = (cap - current) / slope on a clean line", () => {
    // Clean daily-cumulative: $1/day for 14 days. cap=$20.
    // current=$14, slope=$1/day → daysUntilCap = 6.
    const series = Array.from({ length: 14 }, (_, i) => ({
      dayIndex: i,
      cumUsd: i + 1,
    }));
    const r = forecastBurn({ series, capUsd: 20, now: NOW });
    expect(r.slopeUsdPerDay).toBeCloseTo(1, 9);
    expect(r.currentUsd).toBe(14);
    expect(r.daysUntilCap).toBeCloseTo(6, 9);
    // 2026-05-10 + 6 days = 2026-05-16.
    expect(r.projectedCapBreachDate?.slice(0, 10)).toBe("2026-05-16");
  });

  it("returns daysUntilCap=0 when already at or past the cap", () => {
    const series = [{ dayIndex: 0, cumUsd: 25 }];
    const r = forecastBurn({ series, capUsd: 20, now: NOW });
    expect(r.daysUntilCap).toBe(0);
    expect(r.projectedCapBreachDate).toBe(NOW.toISOString());
  });

  it("returns no projection when slope is zero (idle token)", () => {
    // 14 days of flat $1.00 — no burn. Should not pretend a breach.
    const series = Array.from({ length: 14 }, (_, i) => ({
      dayIndex: i,
      cumUsd: 1,
    }));
    const r = forecastBurn({ series, capUsd: 10, now: NOW });
    expect(r.slopeUsdPerDay).toBeCloseTo(0, 9);
    expect(r.daysUntilCap).toBeUndefined();
    expect(r.projectedCapBreachDate).toBeUndefined();
  });

  it("returns no projection when slope is negative", () => {
    // Cumulative spend should never decrease in practice, but if it
    // does (e.g. data corruption), forecasting a "negative breach"
    // would produce a date in the past — refuse to project.
    const series = [
      { dayIndex: 0, cumUsd: 10 },
      { dayIndex: 1, cumUsd: 8 },
      { dayIndex: 2, cumUsd: 6 },
    ];
    const r = forecastBurn({ series, capUsd: 100, now: NOW });
    expect(r.slopeUsdPerDay).toBeLessThan(0);
    expect(r.daysUntilCap).toBeUndefined();
  });

  it("omits projection fields when capUsd is undefined (tag forecast)", () => {
    const series = Array.from({ length: 14 }, (_, i) => ({
      dayIndex: i,
      cumUsd: i + 1,
    }));
    const r = forecastBurn({ series, now: NOW });
    expect(r.slopeUsdPerDay).toBeCloseTo(1, 9);
    expect(r.currentUsd).toBe(14);
    expect(r.daysUntilCap).toBeUndefined();
    expect(r.projectedCapBreachDate).toBeUndefined();
  });
});

describe("utcDayOf", () => {
  it("returns YYYY-MM-DD for a UTC date", () => {
    expect(utcDayOf(new Date("2026-05-10T03:14:15Z"))).toBe("2026-05-10");
  });

  it("uses UTC, not local time", () => {
    // 2026-05-10 23:00 UTC is still 2026-05-10 even in non-UTC zones.
    expect(utcDayOf(new Date("2026-05-10T23:59:59Z"))).toBe("2026-05-10");
    expect(utcDayOf(new Date("2026-05-11T00:00:00Z"))).toBe("2026-05-11");
  });
});
