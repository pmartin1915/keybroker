import { useState } from "react";
import {
  revokeProxyToken,
  MgmtAuthError,
  type TokenRow,
} from "../api/client.js";

/**
 * Phase 4.0 c4d: bulk revoke. Calls DELETE /admin/tokens/:id once per
 * selected row, sequentially, surfacing per-row outcome (revoked,
 * alreadyRevoked, failed). Three-click ceremony matches single-revoke:
 *   modal open → click "Revoke N" → click "Yes, revoke N"
 *
 * Loops are deliberately sequential — preserves audit ordering and
 * keeps surface area predictable when one mid-list call hits an auth
 * error (the rest of the batch is abandoned and the modal re-prompts).
 */

type Outcome =
  | { kind: "pending" }
  | { kind: "revoked"; alreadyRevoked: boolean }
  | { kind: "failed"; message: string };

type Phase = "list" | "confirming" | "running" | "done";

export function BulkRevokeModal({
  tokens,
  onClose,
  onExecuted,
  onNeedsAuth,
}: {
  tokens: TokenRow[];
  onClose: () => void;
  onExecuted: () => void;
  onNeedsAuth: (reason: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("list");
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>(() => {
    const init: Record<string, Outcome> = {};
    for (const t of tokens) init[t.id] = { kind: "pending" };
    return init;
  });

  const run = async () => {
    setPhase("running");
    let mutated = false;
    for (const t of tokens) {
      try {
        const result = await revokeProxyToken(t.id);
        setOutcomes((prev) => ({
          ...prev,
          [t.id]: { kind: "revoked", alreadyRevoked: result.alreadyRevoked === true },
        }));
        mutated = true;
      } catch (e) {
        if (e instanceof MgmtAuthError) {
          // Auth expired mid-batch — abandon remaining rows and let
          // the parent re-prompt. Already-revoked rows stay revoked.
          if (mutated) onExecuted();
          onNeedsAuth(e.message);
          return;
        }
        setOutcomes((prev) => ({
          ...prev,
          [t.id]: { kind: "failed", message: e instanceof Error ? e.message : String(e) },
        }));
      }
    }
    onExecuted();
    setPhase("done");
  };

  const totals = summarize(outcomes);

  return (
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={phase === "running" ? undefined : onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...modalStyle, width: 620 }} className="anim-fade">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
              {phase === "done" ? "Revoke complete" : `Revoke ${tokens.length} tokens`}
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {phase === "list"
                ? "Each row is a separate DELETE /admin/tokens/:id call. This is immediate and cannot be undone."
                : phase === "confirming"
                ? "Last chance to cancel."
                : phase === "running"
                ? "Revoking sequentially…"
                : `Revoked ${totals.revoked} · already-revoked ${totals.alreadyRevoked} · failed ${totals.failed}`}
            </span>
          </div>
          <button
            onClick={onClose}
            disabled={phase === "running"}
            style={closeButtonStyle}
            aria-label="close"
          >
            ×
          </button>
        </header>

        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {tokens.map((t) => (
            <BulkRow
              key={t.id}
              token={t}
              outcome={outcomes[t.id] ?? { kind: "pending" }}
              phase={phase}
            />
          ))}
        </div>

        {phase === "list" ? (
          <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={onClose} style={secondaryButton}>
              Cancel
            </button>
            <button onClick={() => setPhase("confirming")} style={dangerOutlineButton}>
              Revoke {tokens.length} token{tokens.length === 1 ? "" : "s"}…
            </button>
          </footer>
        ) : null}

        {phase === "confirming" ? (
          <>
            <div
              style={{
                background: "rgba(225, 78, 78, 0.08)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius-sm)",
                padding: 12,
                fontSize: 12,
                color: "var(--text-primary)",
              }}
            >
              Revoking {tokens.length} token{tokens.length === 1 ? "" : "s"} is immediate and cannot be undone.
              Any application currently using one of these tokens will start receiving 401s on the next call.
            </div>
            <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setPhase("list")} style={secondaryButton}>
                Back
              </button>
              <button onClick={() => void run()} style={dangerSolidButton}>
                Yes, revoke {tokens.length}
              </button>
            </footer>
          </>
        ) : null}

        {phase === "done" ? (
          <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button onClick={onClose} style={primaryButton}>
              Done
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function summarize(outcomes: Record<string, Outcome>) {
  let revoked = 0;
  let alreadyRevoked = 0;
  let failed = 0;
  let pending = 0;
  for (const o of Object.values(outcomes)) {
    if (o.kind === "revoked") {
      if (o.alreadyRevoked) alreadyRevoked++;
      else revoked++;
    } else if (o.kind === "failed") {
      failed++;
    } else {
      pending++;
    }
  }
  return { revoked, alreadyRevoked, failed, pending };
}

function BulkRow({ token, outcome, phase }: { token: TokenRow; outcome: Outcome; phase: Phase }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 12,
        padding: "10px 12px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 12,
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{token.label}</span>
        <span
          style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {token.id} · {token.provider}
          {token.tagTeam ? ` · team:${token.tagTeam}` : ""}
          {token.tagProject ? ` · proj:${token.tagProject}` : ""}
          {token.tagEnv ? ` · env:${token.tagEnv}` : ""}
        </span>
      </div>
      <OutcomeBadge outcome={outcome} phase={phase} />
    </div>
  );
}

function OutcomeBadge({ outcome, phase }: { outcome: Outcome; phase: Phase }) {
  if (outcome.kind === "revoked") {
    return (
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          color: outcome.alreadyRevoked ? "var(--text-muted)" : "var(--danger)",
        }}
      >
        {outcome.alreadyRevoked ? "ALREADY REVOKED" : "REVOKED"}
      </span>
    );
  }
  if (outcome.kind === "failed") {
    return (
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          color: "var(--danger)",
        }}
        title={outcome.message}
      >
        FAILED
      </span>
    );
  }
  if (phase === "running") {
    return (
      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        …
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
      queued
    </span>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  maxWidth: "92vw",
  background: "var(--bg-paper)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius)",
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  boxShadow: "var(--shadow)",
};

const closeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  fontSize: 20,
  cursor: "pointer",
  padding: 4,
  lineHeight: 1,
};

const primaryButton: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--bg-ink)",
  border: "none",
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryButton: React.CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-subtle)",
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const dangerOutlineButton: React.CSSProperties = {
  background: "transparent",
  color: "var(--danger)",
  border: "1px solid var(--danger)",
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const dangerSolidButton: React.CSSProperties = {
  background: "var(--danger)",
  color: "var(--bg-ink)",
  border: "none",
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};
