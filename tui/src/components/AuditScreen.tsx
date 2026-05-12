import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { type BrokerClient, type AuditRow } from "../api/client.js";
import { useFocusCapture } from "../focus.js";

// Phase 4.1 c3 — Audit screen (read-only filterable call log).
//
// Filter focus model (same vocabulary as c2, locked in
// memory/decision_phase_4_1_c1.md "c2 filter focus model"):
//   f          cycle outcome filter (all → ok → denied → error → egress_blocked)
//   /          open inline search input (free-text)
//   c          clear search query (outcome filter unaffected)
//   r          manual refresh (invariant 6: no auto-refresh)
//   ↑/↓        move row cursor
//   Enter      open selected row's detail panel
//   Esc        close detail panel

type OutcomeFilter = "all" | "ok" | "denied" | "error" | "egress_blocked";
const OUTCOME_CYCLE: OutcomeFilter[] = ["all", "ok", "denied", "error", "egress_blocked"];

const OUTCOME_COLOR: Record<AuditRow["outcome"], string> = {
  ok: "green",
  denied: "yellow",
  error: "red",
  egress_blocked: "magenta",
};

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 8);
  return d.toLocaleTimeString();
}

function fmtCost(n: number | undefined): string {
  if (n === undefined) return "—";
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

interface LoadState {
  rows: AuditRow[];
  loading: boolean;
  error: string | null;
}

interface Counts {
  ok: number;
  denied: number;
  error: number;
  egress_blocked: number;
}

export function AuditScreen({ client }: { client: BrokerClient }) {
  const [state, setState] = useState<LoadState>({
    rows: [],
    loading: true,
    error: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const focus = useFocusCapture();

  useEffect(() => {
    focus.setCapture(searchMode || detailOpen);
    return () => focus.setCapture(false);
  }, [searchMode, detailOpen, focus]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await client.fetchAudit({ limit: 200 });
        if (!cancelled) {
          setState({ rows: data, loading: false, error: null });
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.rows.filter((r) => {
      if (outcome !== "all" && r.outcome !== outcome) return false;
      if (q.length === 0) return true;
      const hay = [
        r.label,
        r.tokenId,
        r.provider,
        r.path,
        r.machine ?? "",
        r.reason ?? "",
        r.requestedModel ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [state.rows, outcome, query]);

  const counts = useMemo<Counts>(() => {
    const c: Counts = { ok: 0, denied: 0, error: 0, egress_blocked: 0 };
    for (const r of state.rows) c[r.outcome]++;
    return c;
  }, [state.rows]);

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput(
    (input, key) => {
      if (input === "/") {
        setSearchDraft(query);
        setSearchMode(true);
        return;
      }
      if (input === "f") {
        const i = OUTCOME_CYCLE.indexOf(outcome);
        const next = OUTCOME_CYCLE[(i + 1) % OUTCOME_CYCLE.length] ?? "all";
        setOutcome(next);
        setCursor(0);
        return;
      }
      if (input === "c") {
        setQuery("");
        setCursor(0);
        return;
      }
      if (input === "r") {
        setRefreshTick((n) => n + 1);
        return;
      }
      if (key.upArrow) {
        setCursor((n) => Math.max(0, n - 1));
        return;
      }
      if (key.downArrow) {
        setCursor((n) => Math.min(Math.max(0, filtered.length - 1), n + 1));
        return;
      }
      if (key.return && filtered.length > 0) {
        setDetailOpen(true);
        return;
      }
    },
    { isActive: !searchMode && !detailOpen },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setDetailOpen(false);
    },
    { isActive: detailOpen },
  );

  const selectedRow = filtered[cursor];

  return (
    <Box flexDirection="column" gap={1}>
      <AuditHeader
        loading={state.loading}
        total={state.rows.length}
        shown={filtered.length}
        lastRefresh={lastRefresh}
        counts={counts}
      />
      {state.error ? <ErrorBanner message={`/audit failed: ${state.error}`} /> : null}
      <FilterBar outcome={outcome} query={query} />
      {searchMode ? (
        <SearchInput
          value={searchDraft}
          onChange={setSearchDraft}
          onSubmit={(v: string) => {
            setQuery(v);
            setSearchMode(false);
            setCursor(0);
          }}
          onCancel={() => setSearchMode(false)}
        />
      ) : null}
      <AuditTable rows={filtered} cursor={cursor} loading={state.loading} />
      <HotkeyHint />
      {detailOpen && selectedRow ? <AuditDetail row={selectedRow} /> : null}
    </Box>
  );
}

function AuditHeader({
  loading,
  total,
  shown,
  lastRefresh,
  counts,
}: {
  loading: boolean;
  total: number;
  shown: number;
  lastRefresh: number;
  counts: Counts;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Audit</Text>
        <Text color="gray">
          {loading ? "loading…" : `${shown} of ${total} calls`} · press r to refresh
        </Text>
        {!loading && total > 0 ? (
          <Text color="gray">
            <Text color="green">ok:{counts.ok}</Text>
            {"  "}
            <Text color="yellow">denied:{counts.denied}</Text>
            {"  "}
            <Text color="red">error:{counts.error}</Text>
            {"  "}
            <Text color="magenta">egress:{counts.egress_blocked}</Text>
          </Text>
        ) : null}
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

function FilterBar({ outcome, query }: { outcome: OutcomeFilter; query: string }) {
  const outcomeColor =
    outcome === "all"
      ? "white"
      : outcome === "ok"
        ? "green"
        : outcome === "denied"
          ? "yellow"
          : outcome === "error"
            ? "red"
            : "magenta";
  return (
    <Box flexDirection="row" gap={2}>
      <Text color="gray">
        filter: <Text bold color={outcomeColor}>{outcome}</Text>
        {"  "}
        search: <Text bold color="white">{query.length > 0 ? `"${query}"` : "—"}</Text>
      </Text>
    </Box>
  );
}

function SearchInput({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
}) {
  useInput(
    (_input, key) => {
      if (key.escape) onCancel();
    },
    { isActive: true },
  );
  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text color="cyan">search: </Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      <Text color="gray">  (Enter to apply · Esc to cancel)</Text>
    </Box>
  );
}

function HotkeyHint() {
  return (
    <Box>
      <Text color="gray">
        <Text color="white">↑↓</Text> move{"  "}
        <Text color="white">Enter</Text> detail{"  "}
        <Text color="white">f</Text> outcome{"  "}
        <Text color="white">/</Text> search{"  "}
        <Text color="white">c</Text> clear{"  "}
        <Text color="white">r</Text> refresh
      </Text>
    </Box>
  );
}

const COL = {
  marker: 2,
  time: 11,
  label: 18,
  provider: 10,
  method: 7,
  httpStatus: 5,
  outcome: 14,
  cost: 12,
};

function AuditTable({
  rows,
  cursor,
  loading,
}: {
  rows: AuditRow[];
  cursor: number;
  loading: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <AuditHeaderRow />
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no calls match the current filter</Text>
      ) : (
        rows.map((r, i) => <AuditLine key={`${r.ts}-${r.tokenId}-${i}`} row={r} active={i === cursor} />)
      )}
    </Box>
  );
}

function AuditHeaderRow() {
  return (
    <Box>
      <Text color="gray" dimColor>
        {" ".padEnd(COL.marker)}
        {"TIME".padEnd(COL.time)}
        {"LABEL".padEnd(COL.label)}
        {"PROVIDER".padEnd(COL.provider)}
        {"METHOD".padEnd(COL.method)}
        {"HTTP".padEnd(COL.httpStatus)}
        {"OUTCOME".padEnd(COL.outcome)}
        {"COST".padEnd(COL.cost)}
      </Text>
    </Box>
  );
}

function AuditLine({ row, active }: { row: AuditRow; active: boolean }) {
  const marker = active ? "> " : "  ";
  const cost = row.actualCostUsd ?? row.estimatedCostUsd;
  const color = OUTCOME_COLOR[row.outcome];
  return (
    <Box>
      <Text color={active ? "cyan" : "gray"}>{marker}</Text>
      <Text color="gray">{truncate(fmtTs(row.ts), COL.time)}</Text>
      <Text color={active ? "cyan" : "white"} bold={active}>
        {truncate(row.label, COL.label)}
      </Text>
      <Text color="gray">{truncate(row.provider, COL.provider)}</Text>
      <Text color="gray">{truncate(row.method, COL.method)}</Text>
      <Text color={row.status >= 400 ? "red" : "white"}>{String(row.status).padEnd(COL.httpStatus)}</Text>
      <Text color={color} bold>{truncate(row.outcome, COL.outcome)}</Text>
      <Text color="gray">{truncate(fmtCost(cost), COL.cost)}</Text>
    </Box>
  );
}

function AuditDetail({ row }: { row: AuditRow }) {
  const cost = row.actualCostUsd ?? row.estimatedCostUsd;
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">{row.label}</Text>
        <Text color="gray">{row.tokenId}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <DetailLine
          label="Outcome"
          value={row.outcome}
          color={OUTCOME_COLOR[row.outcome]}
        />
        {row.reason ? <DetailLine label="Reason" value={row.reason} color="yellow" /> : null}
        <DetailLine label="Provider" value={row.provider} />
        <DetailLine label="Method" value={`${row.method} ${row.path}`} />
        <DetailLine label="HTTP status" value={String(row.status)} color={row.status >= 400 ? "red" : "white"} />
        <DetailLine label="Duration" value={`${row.durationMs} ms`} />
        {row.ttftMs !== undefined ? (
          <DetailLine label="TTFT" value={`${row.ttftMs} ms`} />
        ) : null}
        {row.tpotMsAvg !== undefined ? (
          <DetailLine label="TPOT (mean)" value={`${row.tpotMsAvg.toFixed(2)} ms`} />
        ) : null}
        {row.outputTokens !== undefined ? (
          <DetailLine label="Out tokens" value={String(row.outputTokens)} />
        ) : null}
        <DetailLine label="Req bytes" value={row.reqBytes.toLocaleString()} />
        <DetailLine label="Resp bytes" value={row.respBytes.toLocaleString()} />
        {row.requestedModel ? (
          <DetailLine label="Model" value={row.requestedModel} />
        ) : null}
        {cost !== undefined ? (
          <DetailLine label="Cost" value={fmtCost(cost)} />
        ) : null}
        {row.machine ? <DetailLine label="Machine" value={row.machine} /> : null}
        {row.tagTeam ? <DetailLine label="Team" value={row.tagTeam} /> : null}
        {row.tagProject ? <DetailLine label="Project" value={row.tagProject} /> : null}
        {row.tagEnv ? <DetailLine label="Env" value={row.tagEnv} /> : null}
        <DetailLine label="Time" value={new Date(row.ts).toLocaleString()} />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Esc to close</Text>
      </Box>
    </Box>
  );
}

function DetailLine({
  label,
  value,
  color = "white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <Box>
      <Box width={13}>
        <Text color="gray">{label}</Text>
      </Box>
      <Text color={color}>{value}</Text>
    </Box>
  );
}
