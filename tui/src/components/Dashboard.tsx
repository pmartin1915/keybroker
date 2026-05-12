import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  type BrokerClient,
  type HealthResponse,
  type TagBucket,
  type TagSpendRow,
} from "../api/client.js";

// Phase 4.1 invariant 6: Dashboard auto-refreshes every 5s. All other
// screens (c2..c6) refresh on `r` only. Dashboard gets the live cadence
// because it's the at-a-glance screen — operators leaving it open in a
// tmux pane want it current. 5s is faster than the web UI's 10s; the
// terminal has less visual weight per refresh.
const REFRESH_MS = 5_000;

const BUCKETS: readonly TagBucket[] = ["team", "project", "env"];

interface BucketState {
  data: TagSpendRow[];
  loading: boolean;
  error: string | null;
}

interface HealthState {
  data: HealthResponse | null;
  error: string | null;
}

function fmtUsd(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function emptyBucket(): BucketState {
  return { data: [], loading: true, error: null };
}

export function Dashboard({ client }: { client: BrokerClient }) {
  const [health, setHealth] = useState<HealthState>({ data: null, error: null });
  const [team, setTeam] = useState<BucketState>(emptyBucket());
  const [project, setProject] = useState<BucketState>(emptyBucket());
  const [env, setEnv] = useState<BucketState>(emptyBucket());
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [refreshTick, setRefreshTick] = useState(0);

  // Manual refresh: `r` triggers an extra reload between auto-refresh ticks.
  // Bound here rather than at the App level so it doesn't fire while a
  // future screen (c2..c6) is in focus.
  useInput((input) => {
    if (input === "r") setRefreshTick((n) => n + 1);
  });

  useEffect(() => {
    let cancelled = false;
    const setters: Record<TagBucket, (s: BucketState) => void> = {
      team: setTeam,
      project: setProject,
      env: setEnv,
    };

    const load = async () => {
      try {
        const h = await client.fetchHealth();
        if (!cancelled) setHealth({ data: h, error: null });
      } catch (e) {
        if (!cancelled)
          setHealth({
            data: null,
            error: e instanceof Error ? e.message : String(e),
          });
      }

      await Promise.all(
        BUCKETS.map(async (b) => {
          try {
            const rows = await client.fetchSpend(b, "24h", 10);
            if (!cancelled) setters[b]({ data: rows, loading: false, error: null });
          } catch (e) {
            if (!cancelled)
              setters[b]({
                data: [],
                loading: false,
                error: e instanceof Error ? e.message : String(e),
              });
          }
        }),
      );
      if (!cancelled) setLastRefresh(Date.now());
    };

    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [client, refreshTick]);

  const machineRows: Array<[string, number]> = health.data
    ? Object.entries(health.data.calls.last24hSpendUsdByMachine).sort(
        (a, b) => b[1] - a[1],
      )
    : [];

  return (
    <Box flexDirection="column" gap={1}>
      <Header lastRefresh={lastRefresh} />
      {health.error ? <ErrorBanner message={`/health failed: ${health.error}`} /> : null}

      <StatsRow health={health.data} />

      <Box flexDirection="row" gap={2}>
        <BucketCard title="By team" state={team} />
        <BucketCard title="By project" state={project} />
        <BucketCard title="By env" state={env} />
      </Box>

      <MachineSpendCard rows={machineRows} hasData={health.data !== null} />
    </Box>
  );
}

function Header({ lastRefresh }: { lastRefresh: number }) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Dashboard</Text>
        <Text color="gray">Last 24 hours · refreshes every 5s · press r to refresh now</Text>
      </Box>
      <Text color="gray">updated {new Date(lastRefresh).toLocaleTimeString()}</Text>
    </Box>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Box borderStyle="single" borderColor="red" paddingX={1}>
      <Text color="red">{message}</Text>
    </Box>
  );
}

function StatsRow({ health }: { health: HealthResponse | null }) {
  const cards: Array<{
    label: string;
    value: string;
    hint?: string;
    tone?: "accent" | "danger" | "default";
  }> = health
    ? [
        {
          label: "Active tokens",
          value: String(health.tokens.active),
          hint: `${health.tokens.revoked} revoked`,
        },
        { label: "Calls (24h)", value: health.calls.last24h.toLocaleString() },
        {
          label: "Spend (24h)",
          value: fmtUsd(health.calls.last24hSpendUsd),
          tone: "accent",
        },
        {
          label: "Broker",
          value: health.keybroker_ok ? "OK" : "DEGRADED",
          hint: `v${health.version}`,
          tone: health.keybroker_ok ? "accent" : "danger",
        },
      ]
    : [
        { label: "Active tokens", value: "—" },
        { label: "Calls (24h)", value: "—" },
        { label: "Spend (24h)", value: "—" },
        { label: "Broker", value: "—" },
      ];

  return (
    <Box flexDirection="row" gap={2}>
      {cards.map((c) => (
        <StatCard key={c.label} {...c} />
      ))}
    </Box>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "accent" | "danger" | "default";
}) {
  const color =
    tone === "accent" ? "cyan" : tone === "danger" ? "red" : "white";
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} minWidth={20}>
      <Text color="gray">{label}</Text>
      <Text bold color={color}>{value}</Text>
      {hint ? <Text color="gray">{hint}</Text> : null}
    </Box>
  );
}

function BucketCard({ title, state }: { title: string; state: BucketState }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} minWidth={28}>
      <Text bold>{title}</Text>
      {state.loading ? (
        <Text color="gray">loading…</Text>
      ) : state.error ? (
        <Text color="red">error: {state.error}</Text>
      ) : state.data.length === 0 ? (
        <Text color="gray">no priced calls</Text>
      ) : (
        state.data.slice(0, 5).map((row) => (
          <Box key={row.key || "(none)"} justifyContent="space-between">
            <Text color="white">{row.key || "(unattributed)"}</Text>
            <Text color="gray">{fmtUsd(row.usd)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function MachineSpendCard({
  rows,
  hasData,
}: {
  rows: Array<[string, number]>;
  hasData: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>Spend by machine (24h)</Text>
      {!hasData ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no priced calls</Text>
      ) : (
        rows.map(([machine, usd]) => (
          <Box key={machine || "(none)"} justifyContent="space-between">
            <Text color="white">{machine || "(unattributed)"}</Text>
            <Text color="gray">{fmtUsd(usd)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
