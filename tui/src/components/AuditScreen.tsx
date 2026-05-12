import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  MgmtAuthError,
  type AdminAuditRow,
  type AuditRow,
  type BrokerClient,
} from "../api/client.js";
import { useFocusCapture } from "../focus.js";
import { MgmtTokenPrompt } from "./MgmtTokenPrompt.js";

// Phase 4.1 c3 / c6 — Audit screen (read-only filterable call log).
//
// c3 filter focus model (locked in memory/decision_phase_4_1_c1.md
// "c2 filter focus model"):
//   f          cycle outcome filter (calls view only)
//   /          open inline search input (free-text, both views)
//   c          clear search query
//   r          manual refresh (invariant 6: no auto-refresh)
//   ↑/↓        move row cursor
//   Enter      open selected row's detail panel
//   Esc        close detail panel
//
// c6 view toggle:
//   m          toggle calls ↔ admin actions
// Admin actions require a brkm_… mgmt JWT; on 401 the screen surfaces
// MgmtTokenPrompt with `pending: { kind: "loadAdminAudit" }`. The prompt
// is a *local* modal here (parallel to TokensScreen's modal stack) — no
// new entries in TokensScreen's ModalState union (c5 invariant 1).
// Hotkey convention (c5 invariant 12): `m` is lowercase = read/nav,
// matching the "calls vs mgmt" semantics. No new destructive keys.

type OutcomeFilter = "all" | "ok" | "denied" | "error" | "egress_blocked";
const OUTCOME_CYCLE: OutcomeFilter[] = ["all", "ok", "denied", "error", "egress_blocked"];

type ViewMode = "calls" | "admin";

const OUTCOME_COLOR: Record<AuditRow["outcome"], string> = {
  ok: "green",
  denied: "yellow",
  error: "red",
  egress_blocked: "magenta",
};

const ADMIN_OUTCOME_COLOR: Record<AdminAuditRow["outcome"], string> = {
  ok: "green",
  failed: "red",
};

const ADMIN_ACTION_COLOR: Record<AdminAuditRow["action"], string> = {
  "token.issue": "green",
  "token.revoke": "yellow",
  "token.rotate": "magenta",
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

interface CallsState {
  rows: AuditRow[];
  loading: boolean;
  error: string | null;
}

interface AdminState {
  rows: AdminAuditRow[];
  loading: boolean;
  error: string | null;
  needsAuth: boolean;
}

interface Counts {
  ok: number;
  denied: number;
  error: number;
  egress_blocked: number;
}

export function AuditScreen({ client }: { client: BrokerClient }) {
  const [view, setView] = useState<ViewMode>("calls");

  const [calls, setCalls] = useState<CallsState>({
    rows: [],
    loading: true,
    error: null,
  });
  const [admin, setAdmin] = useState<AdminState>({
    rows: [],
    loading: false,
    error: null,
    needsAuth: false,
  });

  const [refreshTick, setRefreshTick] = useState(0);
  const [adminRefreshTick, setAdminRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [callsCursor, setCallsCursor] = useState(0);
  const [adminCursor, setAdminCursor] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [mgmtPromptOpen, setMgmtPromptOpen] = useState(false);
  const focus = useFocusCapture();

  useEffect(() => {
    focus.setCapture(searchMode || detailOpen || mgmtPromptOpen);
    return () => focus.setCapture(false);
  }, [searchMode, detailOpen, mgmtPromptOpen, focus]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await client.fetchAudit({ limit: 200 });
        if (!cancelled) {
          setCalls({ rows: data, loading: false, error: null });
          setLastRefresh(Date.now());
        }
      } catch (e) {
        if (!cancelled)
          setCalls({
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

  // Admin fetch fires when (a) entering admin view for the first time
  // OR (b) the operator presses `r` while in admin view OR (c) after
  // mgmt-token confirm. We gate on view to avoid burning a 401 on
  // entry if the user never opens admin view.
  useEffect(() => {
    if (view !== "admin") return;
    let cancelled = false;
    const load = async () => {
      setAdmin((s) => ({ ...s, loading: true }));
      try {
        const data = await client.fetchAdminAudit({ limit: 200 });
        if (!cancelled) {
          setAdmin({
            rows: data.rows,
            loading: false,
            error: null,
            needsAuth: false,
          });
          setLastRefresh(Date.now());
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof MgmtAuthError) {
            setAdmin({ rows: [], loading: false, error: null, needsAuth: true });
          } else {
            setAdmin({
              rows: [],
              loading: false,
              error: e instanceof Error ? e.message : String(e),
              needsAuth: false,
            });
          }
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, view, adminRefreshTick]);

  const filteredCalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return calls.rows.filter((r) => {
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
  }, [calls.rows, outcome, query]);

  const filteredAdmin = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return admin.rows;
    return admin.rows.filter((r) => {
      const hay = [
        r.actorLabel ?? "",
        r.actorTokenId,
        r.action,
        r.targetTokenId ?? "",
        r.reason ?? "",
        r.paramsJson ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [admin.rows, query]);

  const counts = useMemo<Counts>(() => {
    const c: Counts = { ok: 0, denied: 0, error: 0, egress_blocked: 0 };
    for (const r of calls.rows) c[r.outcome]++;
    return c;
  }, [calls.rows]);

  useEffect(() => {
    if (view === "calls" && callsCursor >= filteredCalls.length)
      setCallsCursor(Math.max(0, filteredCalls.length - 1));
  }, [filteredCalls.length, callsCursor, view]);
  useEffect(() => {
    if (view === "admin" && adminCursor >= filteredAdmin.length)
      setAdminCursor(Math.max(0, filteredAdmin.length - 1));
  }, [filteredAdmin.length, adminCursor, view]);

  useInput(
    (input, key) => {
      if (input === "/") {
        setSearchDraft(query);
        setSearchMode(true);
        return;
      }
      if (input === "m") {
        setView((v) => (v === "calls" ? "admin" : "calls"));
        setDetailOpen(false);
        return;
      }
      if (input === "f") {
        // outcome cycle only applies in calls view; in admin view it's a no-op.
        if (view !== "calls") return;
        const i = OUTCOME_CYCLE.indexOf(outcome);
        const next = OUTCOME_CYCLE[(i + 1) % OUTCOME_CYCLE.length] ?? "all";
        setOutcome(next);
        setCallsCursor(0);
        return;
      }
      if (input === "c") {
        setQuery("");
        setCallsCursor(0);
        setAdminCursor(0);
        return;
      }
      if (input === "r") {
        if (view === "calls") {
          setRefreshTick((n) => n + 1);
        } else {
          setAdminRefreshTick((n) => n + 1);
        }
        return;
      }
      if (input === "t" && view === "admin" && admin.needsAuth) {
        setMgmtPromptOpen(true);
        return;
      }
      if (key.upArrow) {
        if (view === "calls") setCallsCursor((n) => Math.max(0, n - 1));
        else setAdminCursor((n) => Math.max(0, n - 1));
        return;
      }
      if (key.downArrow) {
        if (view === "calls")
          setCallsCursor((n) =>
            Math.min(Math.max(0, filteredCalls.length - 1), n + 1),
          );
        else
          setAdminCursor((n) =>
            Math.min(Math.max(0, filteredAdmin.length - 1), n + 1),
          );
        return;
      }
      if (key.return) {
        if (view === "calls" && filteredCalls.length > 0) setDetailOpen(true);
        else if (view === "admin" && filteredAdmin.length > 0) setDetailOpen(true);
        return;
      }
    },
    { isActive: !searchMode && !detailOpen && !mgmtPromptOpen },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setDetailOpen(false);
    },
    { isActive: detailOpen && !mgmtPromptOpen },
  );

  const selectedCall = filteredCalls[callsCursor];
  const selectedAdmin = filteredAdmin[adminCursor];

  return (
    <Box flexDirection="column" gap={1}>
      <AuditHeader
        view={view}
        loading={view === "calls" ? calls.loading : admin.loading}
        total={view === "calls" ? calls.rows.length : admin.rows.length}
        shown={view === "calls" ? filteredCalls.length : filteredAdmin.length}
        lastRefresh={lastRefresh}
        counts={counts}
      />
      {view === "calls" && calls.error ? (
        <ErrorBanner message={`/audit failed: ${calls.error}`} />
      ) : null}
      {view === "admin" && admin.error ? (
        <ErrorBanner message={`/admin/audit failed: ${admin.error}`} />
      ) : null}
      {view === "admin" && admin.needsAuth ? (
        <Box borderStyle="single" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            Admin audit requires a management token (brkm_…)
          </Text>
          <Text color="gray">Press <Text color="white">t</Text> to set one for this TUI process.</Text>
        </Box>
      ) : null}
      <FilterBar view={view} outcome={outcome} query={query} />
      {searchMode ? (
        <SearchInput
          value={searchDraft}
          onChange={setSearchDraft}
          onSubmit={(v: string) => {
            setQuery(v);
            setSearchMode(false);
            if (view === "calls") setCallsCursor(0);
            else setAdminCursor(0);
          }}
          onCancel={() => setSearchMode(false)}
        />
      ) : null}
      {view === "calls" ? (
        <AuditTable rows={filteredCalls} cursor={callsCursor} loading={calls.loading} />
      ) : (
        <AdminAuditTable
          rows={filteredAdmin}
          cursor={adminCursor}
          loading={admin.loading}
          needsAuth={admin.needsAuth}
        />
      )}
      <HotkeyHint view={view} adminNeedsAuth={admin.needsAuth} />
      {detailOpen && view === "calls" && selectedCall ? (
        <AuditDetail row={selectedCall} />
      ) : null}
      {detailOpen && view === "admin" && selectedAdmin ? (
        <AdminAuditDetail row={selectedAdmin} />
      ) : null}
      {mgmtPromptOpen ? (
        <MgmtTokenPrompt
          client={client}
          onConfirmed={() => {
            setMgmtPromptOpen(false);
            setAdmin((s) => ({ ...s, needsAuth: false, loading: true }));
            setAdminRefreshTick((n) => n + 1);
          }}
          onCancel={() => setMgmtPromptOpen(false)}
        />
      ) : null}
    </Box>
  );
}

function AuditHeader({
  view,
  loading,
  total,
  shown,
  lastRefresh,
  counts,
}: {
  view: ViewMode;
  loading: boolean;
  total: number;
  shown: number;
  lastRefresh: number;
  counts: Counts;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold color="cyan">Audit</Text>
          <Text color="gray">  view: </Text>
          <Text bold color={view === "calls" ? "cyan" : "gray"}>calls</Text>
          <Text color="gray"> / </Text>
          <Text bold color={view === "admin" ? "cyan" : "gray"}>admin</Text>
          <Text color="gray">  (m toggles)</Text>
        </Box>
        <Text color="gray">
          {loading
            ? "loading…"
            : view === "calls"
              ? `${shown} of ${total} calls`
              : `${shown} of ${total} admin actions`}{" "}
          · press r to refresh
        </Text>
        {!loading && view === "calls" && total > 0 ? (
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

function FilterBar({
  view,
  outcome,
  query,
}: {
  view: ViewMode;
  outcome: OutcomeFilter;
  query: string;
}) {
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
        {view === "calls" ? (
          <>
            filter: <Text bold color={outcomeColor}>{outcome}</Text>
            {"  "}
          </>
        ) : null}
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

function HotkeyHint({ view, adminNeedsAuth }: { view: ViewMode; adminNeedsAuth: boolean }) {
  return (
    <Box>
      <Text color="gray">
        <Text color="white">↑↓</Text> move{"  "}
        <Text color="white">Enter</Text> detail{"  "}
        {view === "calls" ? (
          <>
            <Text color="white">f</Text> outcome{"  "}
          </>
        ) : null}
        <Text color="white">/</Text> search{"  "}
        <Text color="white">c</Text> clear{"  "}
        <Text color="white">m</Text> view{"  "}
        <Text color="white">r</Text> refresh
        {view === "admin" && adminNeedsAuth ? (
          <>
            {"  "}
            <Text color="yellow">t</Text> <Text color="yellow">set mgmt token</Text>
          </>
        ) : null}
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

const ADMIN_COL = {
  marker: 2,
  time: 11,
  actor: 18,
  action: 16,
  target: 22,
  outcome: 9,
};

function AdminAuditTable({
  rows,
  cursor,
  loading,
  needsAuth,
}: {
  rows: AdminAuditRow[];
  cursor: number;
  loading: boolean;
  needsAuth: boolean;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box>
        <Text color="gray" dimColor>
          {" ".padEnd(ADMIN_COL.marker)}
          {"TIME".padEnd(ADMIN_COL.time)}
          {"ACTOR".padEnd(ADMIN_COL.actor)}
          {"ACTION".padEnd(ADMIN_COL.action)}
          {"TARGET".padEnd(ADMIN_COL.target)}
          {"OUTCOME".padEnd(ADMIN_COL.outcome)}
        </Text>
      </Box>
      {needsAuth ? (
        <Text color="gray">management token required — press t above to set it</Text>
      ) : loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no admin actions match</Text>
      ) : (
        rows.map((r, i) => (
          <AdminAuditLine
            key={`${r.ts}-${r.actorTokenId}-${i}`}
            row={r}
            active={i === cursor}
          />
        ))
      )}
    </Box>
  );
}

function AdminAuditLine({ row, active }: { row: AdminAuditRow; active: boolean }) {
  const marker = active ? "> " : "  ";
  const target = row.targetTokenId
    ? row.targetTokenId
    : row.targetCount !== undefined
      ? `${row.targetCount} tokens`
      : "—";
  return (
    <Box>
      <Text color={active ? "cyan" : "gray"}>{marker}</Text>
      <Text color="gray">{truncate(fmtTs(row.ts), ADMIN_COL.time)}</Text>
      <Text color={active ? "cyan" : "white"} bold={active}>
        {truncate(row.actorLabel ?? "(unknown)", ADMIN_COL.actor)}
      </Text>
      <Text color={ADMIN_ACTION_COLOR[row.action]} bold>
        {truncate(row.action, ADMIN_COL.action)}
      </Text>
      <Text color="gray">{truncate(target, ADMIN_COL.target)}</Text>
      <Text color={ADMIN_OUTCOME_COLOR[row.outcome]} bold>
        {truncate(row.outcome, ADMIN_COL.outcome)}
      </Text>
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

function AdminAuditDetail({ row }: { row: AdminAuditRow }) {
  const target = row.targetTokenId
    ? row.targetTokenId
    : row.targetCount !== undefined
      ? `${row.targetCount} tokens rotated`
      : "—";
  let prettyParams: string | null = null;
  if (row.paramsJson) {
    try {
      prettyParams = JSON.stringify(JSON.parse(row.paramsJson), null, 2);
    } catch {
      prettyParams = row.paramsJson;
    }
  }
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
        <Text bold color="cyan">{row.actorLabel ?? "(unknown actor)"}</Text>
        <Text color="gray">{new Date(row.ts).toLocaleString()}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <DetailLine label="Actor (mgmt id)" value={row.actorTokenId} />
        <DetailLine label="Action" value={row.action} color={ADMIN_ACTION_COLOR[row.action]} />
        <DetailLine label="Target" value={target} />
        <DetailLine
          label="Outcome"
          value={row.outcome}
          color={ADMIN_OUTCOME_COLOR[row.outcome]}
        />
        {row.reason ? <DetailLine label="Reason" value={row.reason} color="yellow" /> : null}
        {row.sourceIp ? <DetailLine label="Source IP" value={row.sourceIp} /> : null}
        {row.userAgent ? <DetailLine label="User agent" value={row.userAgent} /> : null}
      </Box>
      {prettyParams ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray" bold>Params (non-secret summary)</Text>
          {prettyParams.split("\n").map((line, i) => (
            <Text key={i} color="white">{line}</Text>
          ))}
        </Box>
      ) : null}
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
      <Box width={16}>
        <Text color="gray">{label}</Text>
      </Box>
      <Text color={color}>{value}</Text>
    </Box>
  );
}
