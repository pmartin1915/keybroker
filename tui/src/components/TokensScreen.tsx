import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { type BrokerClient, type TokenRow } from "../api/client.js";
import { useFocusCapture } from "../focus.js";

// Phase 4.1 c2 — Tokens screen (read-only filterable list).
//
// Filter focus model (locked in memory/decision_phase_4_1_c1.md "c2
// filter focus model"):
//   f          cycle status filter (active -> revoked -> all)
//   /          open inline search input (free-text)
//   c          clear search query (status filter unaffected)
//   r          manual refresh (invariant 6: no auto-refresh)
//   up/down    move row cursor
//   Enter      open selected row's detail panel
//   Esc        close detail panel
//
// Row affordances (revoke/issue/rotate) and multi-select land in c4/c5.

type StatusFilter = "active" | "revoked" | "all";
const STATUS_CYCLE: StatusFilter[] = ["active", "revoked", "all"];

function fmtUsd(n: number): string {
  return (
    "$" +
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function fmtExpiry(epoch: number): string {
  if (epoch === 0) return "never";
  const ms = epoch * 1000;
  const delta = ms - Date.now();
  if (delta < 0) return "expired";
  const days = Math.floor(delta / 86_400_000);
  if (days > 1) return `${days}d`;
  const hours = Math.floor(delta / 3_600_000);
  if (hours > 1) return `${hours}h`;
  const mins = Math.floor(delta / 60_000);
  return `${mins}m`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}

interface LoadState {
  rows: TokenRow[];
  loading: boolean;
  error: string | null;
}

export function TokensScreen({ client }: { client: BrokerClient }) {
  const [state, setState] = useState<LoadState>({
    rows: [],
    loading: true,
    error: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());
  const [status, setStatus] = useState<StatusFilter>("active");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const focus = useFocusCapture();

  // The /-search input owns stdin while open. Same gate detail-open
  // uses — Esc must reach the detail handler without being eaten
  // by App-level hotkeys.
  useEffect(() => {
    focus.setCapture(searchMode || detailOpen);
    return () => focus.setCapture(false);
  }, [searchMode, detailOpen, focus]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await client.fetchTokens();
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
      if (status === "active" && r.revoked) return false;
      if (status === "revoked" && !r.revoked) return false;
      if (q.length === 0) return true;
      const hay = [
        r.label,
        r.id,
        r.provider,
        r.machine ?? "",
        r.tagTeam ?? "",
        r.tagProject ?? "",
        r.tagEnv ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [state.rows, status, query]);

  // Keep cursor in range whenever the filtered set shrinks.
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Hotkeys for the screen itself. Disabled while search-mode or
  // detail-overlay owns input.
  useInput(
    (input, key) => {
      if (input === "/") {
        setSearchDraft(query);
        setSearchMode(true);
        return;
      }
      if (input === "f") {
        const i = STATUS_CYCLE.indexOf(status);
        const next = STATUS_CYCLE[(i + 1) % STATUS_CYCLE.length] ?? "active";
        setStatus(next);
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

  // Detail overlay: Esc closes. Capture is on, so App-level nav is gated.
  useInput(
    (_input, key) => {
      if (key.escape) setDetailOpen(false);
    },
    { isActive: detailOpen },
  );

  const selectedRow = filtered[cursor];

  return (
    <Box flexDirection="column" gap={1}>
      <Header
        loading={state.loading}
        total={state.rows.length}
        shown={filtered.length}
        lastRefresh={lastRefresh}
      />
      {state.error ? <ErrorBanner message={`/tokens failed: ${state.error}`} /> : null}
      <FilterBar status={status} query={query} />
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
      <TokenTable rows={filtered} cursor={cursor} loading={state.loading} />
      <HotkeyHint />
      {detailOpen && selectedRow ? <TokenDetail row={selectedRow} /> : null}
    </Box>
  );
}

function Header({
  loading,
  total,
  shown,
  lastRefresh,
}: {
  loading: boolean;
  total: number;
  shown: number;
  lastRefresh: number;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Tokens</Text>
        <Text color="gray">
          {loading ? "loading…" : `${shown} of ${total} tokens`} · press r to refresh
        </Text>
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

function FilterBar({ status, query }: { status: StatusFilter; query: string }) {
  // Persistent filter status line — the discoverability mitigation for
  // the hidden single-key cycle (decision doc, c2 filter focus model).
  return (
    <Box flexDirection="row" gap={2}>
      <Text color="gray">
        filter: <Text bold color={status === "all" ? "white" : status === "revoked" ? "red" : "cyan"}>{status}</Text>
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
        <Text color="white">↑↓</Text> move  <Text color="white">Enter</Text> detail  <Text color="white">f</Text> filter  <Text color="white">/</Text> search  <Text color="white">c</Text> clear  <Text color="white">r</Text> refresh
      </Text>
    </Box>
  );
}

const COL = {
  marker: 2,
  label: 22,
  id: 14,
  provider: 12,
  tags: 22,
  spend: 16,
  expires: 8,
};

function TokenTable({
  rows,
  cursor,
  loading,
}: {
  rows: TokenRow[];
  cursor: number;
  loading: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <TokenHeaderRow />
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no tokens match the current filter</Text>
      ) : (
        rows.map((r, i) => <TokenLine key={r.id} row={r} active={i === cursor} />)
      )}
    </Box>
  );
}

function TokenHeaderRow() {
  return (
    <Box>
      <Text color="gray" dimColor>
        {" ".padEnd(COL.marker)}
        {"LABEL".padEnd(COL.label)}
        {"ID".padEnd(COL.id)}
        {"PROVIDER".padEnd(COL.provider)}
        {"TAGS · MACHINE".padEnd(COL.tags)}
        {"SPEND / CAP".padEnd(COL.spend)}
        {"EXPIRES".padEnd(COL.expires)}
      </Text>
    </Box>
  );
}

function tagsSummary(r: TokenRow): string {
  const parts: string[] = [];
  if (r.tagTeam) parts.push(`team=${r.tagTeam}`);
  if (r.tagProject) parts.push(`prj=${r.tagProject}`);
  if (r.tagEnv) parts.push(`env=${r.tagEnv}`);
  if (r.machine) parts.push(`mch=${r.machine}`);
  return parts.length > 0 ? parts.join(" ") : "—";
}

function spendSummary(r: TokenRow): string {
  if (r.capUsd !== undefined) return `${fmtUsd(r.spendUsd)}/${fmtUsd(r.capUsd)}`;
  return fmtUsd(r.spendUsd);
}

function TokenLine({ row, active }: { row: TokenRow; active: boolean }) {
  const marker = active ? "> " : "  ";
  const labelColor = row.revoked ? "gray" : active ? "cyan" : "white";
  const overCap = row.capUsd !== undefined && row.spendUsd > row.capUsd;
  return (
    <Box>
      <Text color={active ? "cyan" : "gray"}>{marker}</Text>
      <Text color={labelColor} bold={active}>
        {truncate(row.label, COL.label)}
      </Text>
      <Text color="gray">{truncate(row.id, COL.id)}</Text>
      <Text color={row.revoked ? "red" : "white"}>
        {truncate(row.revoked ? `REVOKED ${row.provider}` : row.provider, COL.provider)}
      </Text>
      <Text color="gray">{truncate(tagsSummary(row), COL.tags)}</Text>
      <Text color={overCap ? "red" : "white"}>{truncate(spendSummary(row), COL.spend)}</Text>
      <Text color="gray">{truncate(fmtExpiry(row.expiresAt), COL.expires)}</Text>
    </Box>
  );
}

function TokenDetail({ row }: { row: TokenRow }) {
  // Mirrors HelpOverlay's render-below-the-fold pattern (Ink 5 has no
  // portal). Capture is on, so global hotkeys are gated; Esc closes.
  // Read-only — revoke affordance lands in c4 with the mgmt JWT modal.
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
        <Text color="gray">{row.id}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <DetailLine label="Status" value={row.revoked ? "REVOKED" : "active"} color={row.revoked ? "red" : "cyan"} />
        <DetailLine label="Provider" value={row.provider} />
        <DetailLine label="Scopes" value={row.scopes.length > 0 ? row.scopes.join(", ") : "—"} />
        {row.machine ? <DetailLine label="Machine" value={row.machine} /> : null}
        {row.tagTeam ? <DetailLine label="Team" value={row.tagTeam} /> : null}
        {row.tagProject ? <DetailLine label="Project" value={row.tagProject} /> : null}
        {row.tagEnv ? <DetailLine label="Env" value={row.tagEnv} /> : null}
        {row.models && row.models.length > 0 ? (
          <DetailLine label="Models" value={row.models.join(", ")} />
        ) : (
          // Phase 3.8 invariant 3 / c4 invariant: surface noModelsClaim
          // with the same wording the web UI uses.
          <DetailLine
            label="Models"
            value="⚠ no models claim — will accept any model"
            color="yellow"
          />
        )}
        <DetailLine label="Spend" value={spendSummary(row)} />
        <DetailLine label="Calls" value={row.used.toLocaleString()} />
        <DetailLine
          label="Remaining"
          value={row.remaining === -1 ? "unlimited" : String(row.remaining)}
        />
        <DetailLine label="Expires" value={fmtExpiry(row.expiresAt)} />
        <DetailLine label="Created" value={new Date(row.createdAt).toLocaleString()} />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Esc to close · revoke lands in Phase 4.1 c4</Text>
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
      <Box width={12}>
        <Text color="gray">{label}</Text>
      </Box>
      <Text color={color}>{value}</Text>
    </Box>
  );
}
