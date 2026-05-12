import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  type BrokerClient,
  type TagBucket,
  type TagForecastRow,
  type TokenForecastRow,
} from "../api/client.js";

// Phase 4.1 c6 — Forecast screen (read-only ASCII).
//
// Web parity: same /forecast/tokens + /forecast/tags endpoints, same
// 14-day window, same `top` caps. Differences:
//   - No Recharts. Tag burn renders as a horizontal ASCII bar chart;
//     burn-leaders renders as an ordered table. Charts in Ink are a
//     rabbit hole; bars are sufficient signal.
//   - No auto-refresh (c1 invariant 6). `r` refreshes manually.
//   - `f` cycles tag bucket (team / project / env), reusing c2's hybrid
//     filter vocabulary.
//
// All endpoints are loopback reads; no mgmt JWT needed.

const BUCKET_CYCLE: TagBucket[] = ["team", "project", "env"];

function fmtUsd(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtDays(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n === 0) return "now";
  if (n < 1) return `${Math.round(n * 24)}h`;
  if (n < 30) return `${n.toFixed(1)}d`;
  return `${Math.round(n)}d`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

interface LoadState {
  tokens: TokenForecastRow[];
  tags: TagForecastRow[];
  loading: boolean;
  error: string | null;
}

export function ForecastScreen({ client }: { client: BrokerClient }) {
  const [state, setState] = useState<LoadState>({
    tokens: [],
    tags: [],
    loading: true,
    error: null,
  });
  const [bucket, setBucket] = useState<TagBucket>("team");
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [tok, tg] = await Promise.all([
          client.fetchTokenForecast({ since: "14d", top: 20 }),
          client.fetchTagForecast(bucket, { since: "14d", top: 10 }),
        ]);
        if (!cancelled) {
          setState({ tokens: tok, tags: tg, loading: false, error: null });
          setLastRefresh(Date.now());
        }
      } catch (e) {
        if (!cancelled)
          setState({
            tokens: [],
            tags: [],
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, bucket, refreshTick]);

  const burnLeaders = useMemo(
    () =>
      [...state.tokens]
        .filter((t) => t.slopeUsdPerDay > 0)
        .sort((a, b) => b.slopeUsdPerDay - a.slopeUsdPerDay)
        .slice(0, 8),
    [state.tokens],
  );

  useInput((input) => {
    if (input === "r") {
      setRefreshTick((n) => n + 1);
      return;
    }
    if (input === "f") {
      const i = BUCKET_CYCLE.indexOf(bucket);
      setBucket(BUCKET_CYCLE[(i + 1) % BUCKET_CYCLE.length] ?? "team");
      return;
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Header
        loading={state.loading}
        bucket={bucket}
        lastRefresh={lastRefresh}
      />
      {state.error ? (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red">forecast failed: {state.error}</Text>
        </Box>
      ) : null}
      <BreachTable rows={state.tokens} loading={state.loading} />
      <BurnLeadersTable rows={burnLeaders} loading={state.loading} />
      <TagBurnChart rows={state.tags} bucket={bucket} loading={state.loading} />
      <HotkeyHint />
    </Box>
  );
}

function Header({
  loading,
  bucket,
  lastRefresh,
}: {
  loading: boolean;
  bucket: TagBucket;
  lastRefresh: number;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Forecast</Text>
        <Text color="gray">
          {loading ? "loading…" : "14-day burn rate"} · bucket{" "}
          <Text bold color="white">{bucket}</Text> · press r to refresh
        </Text>
      </Box>
      <Text color="gray">updated {new Date(lastRefresh).toLocaleTimeString()}</Text>
    </Box>
  );
}

const BREACH = {
  marker: 2,
  label: 22,
  burn: 14,
  current: 18,
  days: 8,
};

function BreachTable({
  rows,
  loading,
}: {
  rows: TokenForecastRow[];
  loading: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray" dimColor>
        Tokens projected to breach cap — ordered by days-until-breach
      </Text>
      <Box>
        <Text color="gray" dimColor>
          {" ".padEnd(BREACH.marker)}
          {"LABEL".padEnd(BREACH.label)}
          {"BURN/d".padEnd(BREACH.burn)}
          {"CURRENT / CAP".padEnd(BREACH.current)}
          {"DAYS".padEnd(BREACH.days)}
        </Text>
      </Box>
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no tokens in window</Text>
      ) : (
        rows.slice(0, 10).map((r) => <BreachLine key={r.tokenId} row={r} />)
      )}
    </Box>
  );
}

function BreachLine({ row }: { row: TokenForecastRow }) {
  const tone =
    row.daysUntilCap === undefined
      ? "gray"
      : row.daysUntilCap < 1
        ? "red"
        : row.daysUntilCap < 7
          ? "yellow"
          : "green";
  const current = row.capUsd
    ? `${fmtUsd(row.currentUsd)} / ${fmtUsd(row.capUsd)}`
    : fmtUsd(row.currentUsd);
  return (
    <Box>
      <Text color="gray">{"  "}</Text>
      <Text color="white">{truncate(row.label, BREACH.label)}</Text>
      <Text color="gray">{truncate(`${fmtUsd(row.slopeUsdPerDay)}/d`, BREACH.burn)}</Text>
      <Text color="gray">{truncate(current, BREACH.current)}</Text>
      <Text color={tone} bold>{fmtDays(row.daysUntilCap).padEnd(BREACH.days)}</Text>
    </Box>
  );
}

const LEADER = {
  marker: 2,
  label: 28,
  provider: 12,
  burn: 14,
};

function BurnLeadersTable({
  rows,
  loading,
}: {
  rows: TokenForecastRow[];
  loading: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray" dimColor>
        Burn leaders — slope of cumulative spend, USD/day
      </Text>
      <Box>
        <Text color="gray" dimColor>
          {" ".padEnd(LEADER.marker)}
          {"LABEL".padEnd(LEADER.label)}
          {"PROVIDER".padEnd(LEADER.provider)}
          {"BURN/d".padEnd(LEADER.burn)}
        </Text>
      </Box>
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no burn detected</Text>
      ) : (
        rows.map((r) => (
          <Box key={r.tokenId}>
            <Text color="gray">{"  "}</Text>
            <Text color="white">{truncate(r.label, LEADER.label)}</Text>
            <Text color="gray">{truncate(r.provider, LEADER.provider)}</Text>
            <Text color="cyan" bold>{truncate(`${fmtUsd(r.slopeUsdPerDay)}/d`, LEADER.burn)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

const BAR_WIDTH = 30;

function TagBurnChart({
  rows,
  bucket,
  loading,
}: {
  rows: TagForecastRow[];
  bucket: TagBucket;
  loading: boolean;
}) {
  const max = rows.reduce((m, r) => Math.max(m, r.slopeUsdPerDay), 0);
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray" dimColor>
        Tag burn rate ({bucket}) — USD/day · press f to cycle bucket
      </Text>
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no tagged spend in window</Text>
      ) : (
        rows.map((r) => {
          const filled =
            max > 0 ? Math.max(1, Math.round((r.slopeUsdPerDay / max) * BAR_WIDTH)) : 0;
          const bar = "█".repeat(filled) + "·".repeat(BAR_WIDTH - filled);
          return (
            <Box key={r.key}>
              <Text color="white">{truncate(r.key, 18)}</Text>
              <Text color="cyan">{bar}</Text>
              <Text color="gray">{` ${fmtUsd(r.slopeUsdPerDay)}/d`}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

function HotkeyHint() {
  return (
    <Box>
      <Text color="gray">
        <Text color="white">f</Text> bucket{"  "}
        <Text color="white">r</Text> refresh
      </Text>
    </Box>
  );
}
