import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  MgmtAuthError,
  type BrokerClient,
  type IssueTokenResponse,
  type RotateFilters,
  type RotatePreview,
  type RotateDryRun,
  type RotateResult,
  type TokenRow,
} from "../api/client.js";
import { useFocusCapture } from "../focus.js";
import { MgmtTokenPrompt } from "./MgmtTokenPrompt.js";
import { IssueTokenForm, IssuedReveal } from "./IssueTokenForm.js";
import { RotateTokensFlow, type RotateStep, type RotateResumeAt } from "./RotateTokensFlow.js";
import { BulkRevokeFlow, type BulkPhase, type BulkOutcome } from "./BulkRevokeFlow.js";

// Phase 4.1 c2 / c4 / c5 — Tokens screen.
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
//   i          (c4) issue new token — prompts for mgmt JWT if needed
//   R          (c5a) rotate matched tokens — 4-step ceremony
//   space      (c5b) toggle selection on cursor row
//   a          (c5b) toggle-all visible active rows
//   X          (c5b) bulk revoke selected (when selection non-empty)
//   Esc        (c5b) clears selection when non-empty and no modal/detail open
//
// Detail-panel hotkeys (c4):
//   x          revoke this token (inline two-step y/n confirm)
//
// Modal stack (c4 + c5a): single tagged-union state machine, 8 variants.
// The auth-recovery flow (issue/revoke/rotate → 401 → mgmt prompt →
// resume) is encoded by the `pending` field on the mgmtPrompt modal.
// Rotate's three resumeAt cases collapse to filter-step re-entry (the
// fleet may have shifted between arm and re-auth — re-walk is correct).
// If the stack starts nesting in c5b/c6 we upgrade to a useReducer-based
// modal stack (c1 invariant 10 escape hatch). At 8 variants today the
// union still reads cleaner than a reducer (c4 invariant 1's threshold
// is implicitly about nested/stacked modals, not sequential ones).

type PendingAction =
  | { kind: "issue" }
  | { kind: "revoke"; tokenId: string; label: string }
  | { kind: "rotate"; filters: RotateFilters; resumeAt: RotateResumeAt }
  | {
      kind: "bulkRevoke";
      remainingIds: string[];
      outcomesSoFar: Record<string, BulkOutcome>;
    };

type ModalState =
  | { kind: "none" }
  | { kind: "mgmtPrompt"; reason?: string; pending: PendingAction }
  | { kind: "issue" }
  | { kind: "issueReveal"; response: IssueTokenResponse }
  | { kind: "rotateFilter"; initial: RotateFilters }
  | { kind: "rotatePreview"; filters: RotateFilters; data: RotatePreview }
  | { kind: "rotateDryRun"; filters: RotateFilters; data: RotateDryRun }
  | { kind: "rotateReveal"; result: RotateResult }
  | { kind: "bulkRevokeConfirm"; tokens: TokenRow[] }
  | {
      kind: "bulkRevokeRunning";
      tokens: TokenRow[];
      outcomes: Record<string, BulkOutcome>;
    }
  | { kind: "bulkRevokeDone"; outcomes: Record<string, BulkOutcome> };

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
  const [modal, setModal] = useState<ModalState>({ kind: "none" });
  const [revokeConfirming, setRevokeConfirming] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // c5b: multi-select state. Persists across status/query changes
  // (web 4d invariant 2). Revoked rows are not selectable (4d invariant
  // 1); the toggle helpers below enforce that.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const focus = useFocusCapture();

  // The /-search input, detail panel, and any modal own stdin while
  // active. Esc must reach the right handler — gating useInputs via
  // isActive flags is the only way Ink lets us swallow events.
  const modalOpen = modal.kind !== "none";
  useEffect(() => {
    focus.setCapture(searchMode || detailOpen || modalOpen);
    return () => focus.setCapture(false);
  }, [searchMode, detailOpen, modalOpen, focus]);

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

  // ── Admin actions ────────────────────────────────────────────────
  //
  // Auth-recovery contract (c4 web parity): if any admin call throws
  // MgmtAuthError, push a MgmtTokenPrompt with the pending action stored
  // on it. The prompt's onConfirmed re-fires the pending action — form
  // state for `issue` is dropped intentionally (user re-fills after
  // auth), `revoke` carries its target id so the user doesn't have to
  // re-navigate to the row.
  const openIssue = () => {
    if (!client.hasMgmtToken()) {
      setModal({ kind: "mgmtPrompt", pending: { kind: "issue" } });
      return;
    }
    setModal({ kind: "issue" });
  };

  const openRotate = () => {
    if (!client.hasMgmtToken()) {
      // No filters collected yet — resumeAt is irrelevant for this case;
      // onAuthConfirmed routes to filter step on filters=={} regardless.
      setModal({
        kind: "mgmtPrompt",
        pending: { kind: "rotate", filters: {}, resumeAt: "preview" },
      });
      return;
    }
    setModal({ kind: "rotateFilter", initial: {} });
  };

  // c5b: selection helpers. Active-row-only guards enforce 4d invariant 1
  // (revoked rows are not selectable) — both the toggle and the toggle-all
  // refuse to add a revoked id.
  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        const row = state.rows.find((r) => r.id === id);
        if (row && !row.revoked) next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAllVisibleActive = () => {
    const visibleActive = filtered.filter((r) => !r.revoked).map((r) => r.id);
    if (visibleActive.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visibleActive.every((id) => next.has(id));
      if (allSelected) {
        for (const id of visibleActive) next.delete(id);
      } else {
        for (const id of visibleActive) next.add(id);
      }
      return next;
    });
  };

  const openBulkRevoke = () => {
    // Resolve selection against the current (latest-fetched) rows. Any
    // row revoked-since-selection drops out — the count shown in the
    // confirm phase will reflect the actually-revokable set (web 4d
    // invariant 1 maintained at the modal boundary too).
    const tokens = state.rows.filter((r) => selectedIds.has(r.id) && !r.revoked);
    if (tokens.length === 0) return;
    if (!client.hasMgmtToken()) {
      setModal({
        kind: "mgmtPrompt",
        pending: {
          kind: "bulkRevoke",
          remainingIds: tokens.map((t) => t.id),
          outcomesSoFar: {},
        },
      });
      return;
    }
    setModal({ kind: "bulkRevokeConfirm", tokens });
  };

  const performRevoke = async (tokenId: string, label: string) => {
    setRevokeError(null);
    try {
      await client.revokeProxyToken(tokenId);
      // Refresh the list so the row flips to REVOKED visually and close
      // the detail panel — the row's affordance is no longer meaningful.
      setRefreshTick((n) => n + 1);
      setDetailOpen(false);
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        setDetailOpen(false);
        setModal({
          kind: "mgmtPrompt",
          reason: e.message,
          pending: { kind: "revoke", tokenId, label },
        });
        return;
      }
      setRevokeError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAuthConfirmed = (pending: PendingAction) => {
    if (pending.kind === "issue") {
      setModal({ kind: "issue" });
      return;
    }
    if (pending.kind === "rotate") {
      // c5a: all three resumeAt cases collapse to filter-step re-entry.
      // Filters were already typed (unless this was an initial open with
      // no token — filters=={} — in which case the operator hasn't picked
      // a target yet). The fleet may have shifted between arm and re-auth;
      // forcing a re-walk is the correct ceremony, not a footgun
      // shortcut. The resumeAt field is preserved on the pending shape
      // for future-proofing / telemetry.
      setModal({ kind: "rotateFilter", initial: pending.filters });
      return;
    }
    if (pending.kind === "bulkRevoke") {
      // c5b: resume the loop with the un-attempted tail. We rebuild the
      // tokens array against the *current* state.rows (a row revoked
      // behind the scenes drops out — the loop would have hit
      // alreadyRevoked anyway, but skipping it pre-auth is cleaner).
      // outcomesSoFar carries forward so already-revoked rows render
      // with their final badge alongside the resumed pending rows.
      const tokens = state.rows.filter(
        (r) => pending.remainingIds.includes(r.id) && !r.revoked,
      );
      if (tokens.length === 0) {
        // Nothing left to attempt. If anything was attempted before
        // the auth blew up, the running phase already fired onExecuted
        // and TokensScreen refreshed. Drop the modal.
        setModal({ kind: "none" });
        return;
      }
      const outcomes: Record<string, BulkOutcome> = { ...pending.outcomesSoFar };
      for (const t of tokens) {
        if (!outcomes[t.id] || outcomes[t.id]?.kind !== "pending") {
          outcomes[t.id] = { kind: "pending" };
        }
      }
      setModal({ kind: "bulkRevokeRunning", tokens, outcomes });
      return;
    }
    // revoke: re-fire and clear modal. If it 401s again the screen will
    // re-push the prompt; the user's only escape is Esc-cancelling.
    setModal({ kind: "none" });
    void performRevoke(pending.tokenId, pending.label);
  };

  // Hotkeys for the screen itself. Disabled while search-mode, detail-
  // overlay, or any modal owns input.
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
      if (input === "i") {
        openIssue();
        return;
      }
      if (input === "R") {
        // Capital R — destructive sibling of lowercase r (refresh).
        // c5a: opens the 4-step rotate ceremony.
        openRotate();
        return;
      }
      // c5b: selection + bulk revoke. Order matters here:
      //   space → toggle cursor row (only if it's an active row)
      //   a     → toggle all visible-active
      //   X     → open bulk revoke (only if selection non-empty)
      //   Esc   → clear selection (only if non-empty, no detail/modal owns input)
      if (input === " ") {
        const row = filtered[cursor];
        if (row && !row.revoked) toggleSelection(row.id);
        return;
      }
      if (input === "a") {
        toggleSelectAllVisibleActive();
        return;
      }
      if (input === "X") {
        if (selectedIds.size > 0) openBulkRevoke();
        return;
      }
      if (key.escape) {
        if (selectedIds.size > 0) {
          setSelectedIds(new Set());
          return;
        }
        // Fall through — no other Esc handler at the default-state level
        // today (detail / modal / search own their own Esc).
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
        setRevokeConfirming(false);
        setRevokeError(null);
        return;
      }
    },
    { isActive: !searchMode && !detailOpen && !modalOpen },
  );

  // Detail overlay: Esc closes, x triggers two-step revoke. Confirm with
  // y, cancel with n / Esc. Disabled while a modal owns input (auth
  // prompt over detail panel) so Esc bubbles to the modal handler.
  useInput(
    (input, key) => {
      if (revokeConfirming) {
        if (input === "y") {
          const row = filtered[cursor];
          if (row && !row.revoked) {
            setRevokeConfirming(false);
            void performRevoke(row.id, row.label);
          }
          return;
        }
        if (input === "n" || key.escape) {
          setRevokeConfirming(false);
          return;
        }
        return;
      }
      if (key.escape) {
        setDetailOpen(false);
        setRevokeError(null);
        return;
      }
      if (input === "x") {
        const row = filtered[cursor];
        if (row && !row.revoked) setRevokeConfirming(true);
        return;
      }
    },
    { isActive: detailOpen && !modalOpen },
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
      <FilterBar status={status} query={query} selectedCount={selectedIds.size} />
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
      <TokenTable
        rows={filtered}
        cursor={cursor}
        loading={state.loading}
        selectedIds={selectedIds}
      />
      <HotkeyHint selectedCount={selectedIds.size} />
      {revokeError ? (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red">revoke failed: {revokeError}</Text>
        </Box>
      ) : null}
      {detailOpen && selectedRow ? (
        <TokenDetail
          row={selectedRow}
          confirming={revokeConfirming}
          modalOpen={modalOpen}
        />
      ) : null}
      {modal.kind === "mgmtPrompt" ? (
        <MgmtTokenPrompt
          client={client}
          initialReason={modal.reason}
          onConfirmed={() => onAuthConfirmed(modal.pending)}
          onCancel={() => setModal({ kind: "none" })}
        />
      ) : null}
      {modal.kind === "issue" ? (
        <IssueTokenForm
          client={client}
          onCancel={() => setModal({ kind: "none" })}
          onIssued={(response) => {
            setModal({ kind: "issueReveal", response });
            // Refresh the list so the new token appears once the operator
            // dismisses the reveal.
            setRefreshTick((n) => n + 1);
          }}
          onNeedsAuth={(reason) =>
            setModal({
              kind: "mgmtPrompt",
              reason,
              pending: { kind: "issue" },
            })
          }
        />
      ) : null}
      {modal.kind === "issueReveal" ? (
        <IssuedReveal
          response={modal.response}
          onDismiss={() => setModal({ kind: "none" })}
        />
      ) : null}
      {modal.kind === "rotateFilter" ||
      modal.kind === "rotatePreview" ||
      modal.kind === "rotateDryRun" ||
      modal.kind === "rotateReveal" ? (
        <RotateTokensFlow
          client={client}
          step={modalToRotateStep(modal)}
          onTransition={(next: RotateStep) => setModal(rotateStepToModal(next))}
          onClose={() => setModal({ kind: "none" })}
          onNeedsAuth={(filters, resumeAt) =>
            setModal({
              kind: "mgmtPrompt",
              pending: { kind: "rotate", filters, resumeAt },
            })
          }
          onExecuted={() => setRefreshTick((n) => n + 1)}
        />
      ) : null}
      {modal.kind === "bulkRevokeConfirm" ||
      modal.kind === "bulkRevokeRunning" ||
      modal.kind === "bulkRevokeDone" ? (
        <BulkRevokeFlow
          client={client}
          phase={modalToBulkPhase(modal)}
          onTransition={(next: BulkPhase) => setModal(bulkPhaseToModal(next))}
          onClose={() => {
            // c5b: clear any rows we attempted from the selection so the
            // operator's selection set tracks reality. Anything that
            // stayed `pending` (e.g. they Esc'd a mid-batch mgmt prompt)
            // remains selected — re-opening bulk revoke will re-target
            // them, which is the intended affordance.
            const attempted = computeAttemptedIds(modal);
            if (attempted.size > 0) {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                for (const id of attempted) next.delete(id);
                return next;
              });
            }
            setModal({ kind: "none" });
          }}
          onNeedsAuth={(remainingIds, outcomesSoFar) =>
            setModal({
              kind: "mgmtPrompt",
              pending: { kind: "bulkRevoke", remainingIds, outcomesSoFar },
            })
          }
          onExecuted={() => setRefreshTick((n) => n + 1)}
        />
      ) : null}
    </Box>
  );
}

function modalToRotateStep(modal: ModalState): RotateStep {
  if (modal.kind === "rotateFilter") return { kind: "filter", initial: modal.initial };
  if (modal.kind === "rotatePreview")
    return { kind: "preview", filters: modal.filters, data: modal.data };
  if (modal.kind === "rotateDryRun")
    return { kind: "dryRun", filters: modal.filters, data: modal.data };
  if (modal.kind === "rotateReveal") return { kind: "reveal", result: modal.result };
  throw new Error(`unreachable: modal.kind=${modal.kind}`);
}

function rotateStepToModal(step: RotateStep): ModalState {
  if (step.kind === "filter") return { kind: "rotateFilter", initial: step.initial };
  if (step.kind === "preview")
    return { kind: "rotatePreview", filters: step.filters, data: step.data };
  if (step.kind === "dryRun")
    return { kind: "rotateDryRun", filters: step.filters, data: step.data };
  return { kind: "rotateReveal", result: step.result };
}

function modalToBulkPhase(modal: ModalState): BulkPhase {
  if (modal.kind === "bulkRevokeConfirm")
    return { kind: "confirm", tokens: modal.tokens };
  if (modal.kind === "bulkRevokeRunning")
    return { kind: "running", tokens: modal.tokens, outcomes: modal.outcomes };
  if (modal.kind === "bulkRevokeDone")
    return { kind: "done", outcomes: modal.outcomes };
  throw new Error(`unreachable: modal.kind=${modal.kind}`);
}

function bulkPhaseToModal(phase: BulkPhase): ModalState {
  if (phase.kind === "confirm")
    return { kind: "bulkRevokeConfirm", tokens: phase.tokens };
  if (phase.kind === "running")
    return {
      kind: "bulkRevokeRunning",
      tokens: phase.tokens,
      outcomes: phase.outcomes,
    };
  return { kind: "bulkRevokeDone", outcomes: phase.outcomes };
}

function computeAttemptedIds(modal: ModalState): Set<string> {
  // The set of token ids that the bulk flow already touched (revoked,
  // already-revoked, or failed). Used to clear the operator's selection
  // on bulk-flow close so they don't see stale checkmarks.
  const ids = new Set<string>();
  if (modal.kind === "bulkRevokeRunning" || modal.kind === "bulkRevokeDone") {
    for (const [id, outcome] of Object.entries(modal.outcomes)) {
      if (outcome.kind !== "pending") ids.add(id);
    }
  }
  return ids;
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

function FilterBar({
  status,
  query,
  selectedCount,
}: {
  status: StatusFilter;
  query: string;
  selectedCount: number;
}) {
  // Persistent filter status line — the discoverability mitigation for
  // the hidden single-key cycle (decision doc, c2 filter focus model).
  // c5b: surfaces the selection count when non-zero so the operator
  // sees they have rows armed for bulk revoke even after filter toggles.
  return (
    <Box flexDirection="row" gap={2}>
      <Text color="gray">
        filter: <Text bold color={status === "all" ? "white" : status === "revoked" ? "red" : "cyan"}>{status}</Text>
        {"  "}
        search: <Text bold color="white">{query.length > 0 ? `"${query}"` : "—"}</Text>
        {selectedCount > 0 ? (
          <>
            {"  "}selected: <Text bold color="yellow">{selectedCount}</Text>
          </>
        ) : null}
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

function HotkeyHint({ selectedCount }: { selectedCount: number }) {
  return (
    <Box flexDirection="column">
      <Text color="gray">
        <Text color="white">↑↓</Text> move  <Text color="white">Enter</Text> detail  <Text color="white">f</Text> filter  <Text color="white">/</Text> search  <Text color="white">c</Text> clear  <Text color="white">r</Text> refresh  <Text color="white">i</Text> issue  <Text color="red">R</Text> rotate
      </Text>
      <Text color="gray">
        <Text color="white">space</Text> select  <Text color="white">a</Text> all-visible
        {selectedCount > 0 ? (
          <>
            {"  "}<Text color="red" bold>X</Text> <Text color="yellow">revoke·{selectedCount}</Text>{"  "}<Text color="white">Esc</Text> clear
          </>
        ) : null}
      </Text>
    </Box>
  );
}

// c5b: leading `select` column at width 4 — `[x] ` selected, `[ ] `
// selectable, `    ` (4-space spacer) for revoked rows (4d invariant 1:
// revoked rows are not selectable, render as blank spacer rather than a
// disabled checkbox). Glyphs are ASCII (`[x]`) intentionally — unicode
// checkmark glyphs render unreliably across Windows terminal codepages.
const COL = {
  select: 4,
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
  selectedIds,
}: {
  rows: TokenRow[];
  cursor: number;
  loading: boolean;
  selectedIds: Set<string>;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <TokenHeaderRow />
      {loading ? (
        <Text color="gray">loading…</Text>
      ) : rows.length === 0 ? (
        <Text color="gray">no tokens match the current filter</Text>
      ) : (
        rows.map((r, i) => (
          <TokenLine
            key={r.id}
            row={r}
            active={i === cursor}
            selected={selectedIds.has(r.id)}
          />
        ))
      )}
    </Box>
  );
}

function TokenHeaderRow() {
  return (
    <Box>
      <Text color="gray" dimColor>
        {" ".padEnd(COL.select)}
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

function TokenLine({
  row,
  active,
  selected,
}: {
  row: TokenRow;
  active: boolean;
  selected: boolean;
}) {
  const marker = active ? "> " : "  ";
  const labelColor = row.revoked ? "gray" : active ? "cyan" : "white";
  const overCap = row.capUsd !== undefined && row.spendUsd > row.capUsd;
  // 4d invariant 1: revoked rows get blank spacer, never a disabled box.
  const selectGlyph = row.revoked ? "    " : selected ? "[x] " : "[ ] ";
  const selectColor = row.revoked ? "gray" : selected ? "cyan" : "gray";
  return (
    <Box>
      <Text color={selectColor} bold={selected}>{selectGlyph}</Text>
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

function TokenDetail({
  row,
  confirming,
  modalOpen,
}: {
  row: TokenRow;
  confirming: boolean;
  modalOpen: boolean;
}) {
  // Mirrors HelpOverlay's render-below-the-fold pattern (Ink 5 has no
  // portal). Capture is on, so global hotkeys are gated; Esc closes.
  // c4 added inline two-step revoke: `x` arms `confirming`, `y`
  // confirms / `n` / `Esc` cancels. Auth recovery happens at the
  // screen level by pushing a mgmt-prompt modal on MgmtAuthError.
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
      {row.revoked ? null : modalOpen ? (
        <Box marginTop={1}>
          <Text color="gray" dimColor>(action paused — handle mgmt prompt first)</Text>
        </Box>
      ) : confirming ? (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor="red"
          paddingX={1}
          flexDirection="column"
        >
          <Text color="red">
            Revoke <Text bold>{row.label}</Text>? Immediate, cannot be undone.
          </Text>
          <Text color="gray">
            <Text color="red" bold>y</Text> confirm  <Text color="white" bold>n</Text> / <Text color="white" bold>Esc</Text> cancel
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="gray">
            <Text color="white">Esc</Text> close  <Text color="red">x</Text> revoke
          </Text>
        </Box>
      )}
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
