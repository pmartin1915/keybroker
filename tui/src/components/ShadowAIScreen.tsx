import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { type AuditRow, type BrokerClient } from "../api/client.js";
import { useFocusCapture } from "../focus.js";

// Phase 4.1 c6 — Shadow AI screen.
//
// Same wedge story as web/'s ShadowAIScreen: every row is a prompt the
// broker refused to forward upstream. Grouped by detector name (reason
// field on egress_blocked rows). The matched substring is NEVER logged
// — Phase 3.6 scanner invariant 1.
//
// Filter model: list of detector buckets; ↑↓ moves cursor; Enter opens
// detail rows for that bucket. No filter/search input — buckets are
// already small. `r` refreshes (c1 invariant 6 — no auto-refresh).

const fmtTs = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

const truncate = (s: string, n: number): string => {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
};

interface DetectorBucket {
  name: string;
  count: number;
  uniqueTokens: Set<string>;
  uniqueMachines: Set<string>;
  rows: AuditRow[];
  firstSeen: string;
  lastSeen: string;
}

interface LoadState {
  rows: AuditRow[];
  loading: boolean;
  error: string | null;
}

export function ShadowAIScreen({ client }: { client: BrokerClient }) {
  const [state, setState] = useState<LoadState>({
    rows: [],
    loading: true,
    error: null,
  });
  const [cursor, setCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const focus = useFocusCapture();

  useEffect(() => {
    focus.setCapture(detailOpen);
    return () => focus.setCapture(false);
  }, [detailOpen, focus]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await client.fetchAudit({ limit: 500 });
        if (!cancelled) {
          setState({
            rows: data.filter((r) => r.outcome === "egress_blocked"),
            loading: false,
            error: null,
          });
          setLastRefresh(Date.now());
        }
      } catch (e) {
        if (!cancelled)
          setState({
            rows: [],
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, refreshTick]);

  const buckets = useMemo<DetectorBucket[]>(() => {
    const m = new Map<string, DetectorBucket>();
    for (const r of state.rows) {
      const name = r.reason || "(unknown)";
      let b = m.get(name);
      if (!b) {
        b = {
          name,
          count: 0,
          uniqueTokens: new Set(),
          uniqueMachines: new Set(),
          rows: [],
          firstSeen: r.ts,
          lastSeen: r.ts,
        };
        m.set(name, b);
      }
      b.count++;
      b.uniqueTokens.add(r.tokenId);
      if (r.machine) b.uniqueMachines.add(r.machine);
      b.rows.push(r);
      if (r.ts < b.firstSeen) b.firstSeen = r.ts;
      if (r.ts > b.lastSeen) b.lastSeen = r.ts;
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [state.rows]);

  useEffect(() => {
    if (cursor >= buckets.length) setCursor(Math.max(0, buckets.length - 1));
  }, [buckets.length, cursor]);

  useInput(
    (input, key) => {
      if (input === "r") {
        setRefreshTick((n) => n + 1);
        return;
      }
      if (key.upArrow) {
        setCursor((n) => Math.max(0, n - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((n) => Math.min(Math.max(0, buckets.length - 1), n + 1));
        return;
      }
      if (key.return && buckets.length > 0) {
        setDetailOpen(true);
        return;
      }
    },
    { isActive: !detailOpen },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setDetailOpen(false);
    },
    { isActive: detailOpen },
  );

  const selectedBucket = buckets[cursor];

  return (
    <Box flexDirection="column" gap={1}>
      <Header
        loading={state.loading}
        total={state.rows.length}
        bucketCount={buckets.length}
        lastRefresh={lastRefresh}
      />
      {state.error ? (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red">/audit failed: {state.error}</Text>
        </Box>
      ) : null}
      <Footnote />
      <DetectorList
        buckets={buckets}
        cursor={cursor}
        loading={state.loading}
      />
      <HotkeyHint />
      {detailOpen && selectedBucket ? <DetectorDetail bucket={selectedBucket} /> : null}
    </Box>
  );
}

function Header({
  loading,
  total,
  bucketCount,
  lastRefresh,
}: {
  loading: boolean;
  total: number;
  bucketCount: number;
  lastRefresh: number;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Shadow AI</Text>
        <Text color="gray">
          {loading
            ? "loading…"
            : `${total} egress-blocked event${total === 1 ? "" : "s"} across ${bucketCount} detector${bucketCount === 1 ? "" : "s"}`}{" "}
          · press r to refresh
        </Text>
      </Box>
      <Text color="gray">updated {new Date(lastRefresh).toLocaleTimeString()}</Text>
    </Box>
  );
}

function Footnote() {
  return (
    <Box borderStyle="single" borderColor="magenta" paddingX={1}>
      <Text color="gray">
        Every row below is a prompt the broker refused to forward upstream. The detector matched secret material in the request body and the call was rejected before any byte left the machine. <Text bold>The matched substring is never logged</Text> — only the detector name.
      </Text>
    </Box>
  );
}

const COL = {
  marker: 2,
  detector: 26,
  count: 8,
  tokens: 10,
  machines: 12,
  lastSeen: 22,
};

function DetectorList({
  buckets,
  cursor,
  loading,
}: {
  buckets: DetectorBucket[];
  cursor: number;
  loading: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="gray" dimColor>
          {" ".padEnd(COL.marker)}
          {"DETECTOR".padEnd(COL.detector)}
          {"COUNT".padEnd(COL.count)}
          {"TOKENS".padEnd(COL.tokens)}
          {"MACHINES".padEnd(COL.machines)}
          {"LAST SEEN".padEnd(COL.lastSeen)}
        </Text>
      </Box>
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : buckets.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color="green" bold>No secrets caught in the last 500 calls.</Text>
          <Text color="gray">
            The scanner runs on every outbound prompt. When something fires it shows up here grouped by detector.
          </Text>
        </Box>
      ) : (
        buckets.map((b, i) => (
          <Box key={b.name}>
            <Text color={i === cursor ? "cyan" : "gray"}>{i === cursor ? "> " : "  "}</Text>
            <Text color={i === cursor ? "cyan" : "magenta"} bold={i === cursor}>
              {truncate(b.name, COL.detector)}
            </Text>
            <Text color="white" bold>{String(b.count).padEnd(COL.count)}</Text>
            <Text color="gray">{String(b.uniqueTokens.size).padEnd(COL.tokens)}</Text>
            <Text color="gray">{String(b.uniqueMachines.size).padEnd(COL.machines)}</Text>
            <Text color="gray">{truncate(fmtTs(b.lastSeen), COL.lastSeen)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}

function HotkeyHint() {
  return (
    <Box>
      <Text color="gray">
        <Text color="white">↑↓</Text> move{"  "}
        <Text color="white">Enter</Text> events{"  "}
        <Text color="white">r</Text> refresh
      </Text>
    </Box>
  );
}

const DETAIL = {
  time: 22,
  label: 18,
  machine: 14,
  path: 24,
  tags: 24,
};

function DetectorDetail({ bucket }: { bucket: DetectorBucket }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="magenta"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="magenta">Detector: {bucket.name}</Text>
        <Text color="gray">
          {bucket.rows.length} event{bucket.rows.length === 1 ? "" : "s"}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {"TIME".padEnd(DETAIL.time)}
          {"LABEL".padEnd(DETAIL.label)}
          {"MACHINE".padEnd(DETAIL.machine)}
          {"PROVIDER · PATH".padEnd(DETAIL.path)}
          {"TAGS".padEnd(DETAIL.tags)}
        </Text>
      </Box>
      {bucket.rows.slice(0, 20).map((r, i) => (
        <Box key={`${r.ts}-${r.tokenId}-${i}`}>
          <Text color="gray">{truncate(fmtTs(r.ts), DETAIL.time)}</Text>
          <Text color="white">{truncate(r.label, DETAIL.label)}</Text>
          <Text color="gray">{truncate(r.machine ?? "—", DETAIL.machine)}</Text>
          <Text color="gray">
            {truncate(`${r.provider} ${r.path}`, DETAIL.path)}
          </Text>
          <Text color="gray">
            {truncate(
              [r.tagTeam, r.tagProject, r.tagEnv].filter(Boolean).join(" · ") || "—",
              DETAIL.tags,
            )}
          </Text>
        </Box>
      ))}
      {bucket.rows.length > 20 ? (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            (showing 20 of {bucket.rows.length})
          </Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">Esc to close</Text>
      </Box>
    </Box>
  );
}
