import { useEffect, useMemo, useState } from "react";
import {
  fetchAudit,
  fetchAdminAudit,
  MgmtAuthError,
  type AuditRow,
  type AdminAuditRow,
} from "../api/client.js";
import { MgmtTokenModal } from "./MgmtTokenModal.js";

const REFRESH_MS = 10_000;

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const fmtTs = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

type OutcomeFilter = "all" | "ok" | "denied" | "error" | "egress_blocked";
type ViewMode = "calls" | "admin";

const outcomeColor: Record<AuditRow["outcome"], string> = {
  ok: "var(--success)",
  denied: "var(--warning)",
  error: "var(--danger)",
  egress_blocked: "var(--accent-rose)",
};

const adminOutcomeColor: Record<AdminAuditRow["outcome"], string> = {
  ok: "var(--success)",
  failed: "var(--danger)",
};

const adminActionColor: Record<AdminAuditRow["action"], string> = {
  "token.issue": "var(--success)",
  "token.revoke": "var(--warning)",
  "token.rotate": "var(--accent-rose)",
};

export function AuditScreen() {
  const [view, setView] = useState<ViewMode>("calls");

  // ── Calls state ───────────────────────────────────────────────────────────
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [callsLoading, setCallsLoading] = useState(true);
  const [callsError, setCallsError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [selectedCallIdx, setSelectedCallIdx] = useState<number | null>(null);

  // ── Admin state ───────────────────────────────────────────────────────────
  const [adminRows, setAdminRows] = useState<AdminAuditRow[]>([]);
  const [adminLoading, setAdminLoading] = useState(true);
  const [adminError, setAdminError] = useState<string | null>(null);
  // adminNeedsAuth: true when the last fetch 401'd and we need a mgmt token.
  const [adminNeedsAuth, setAdminNeedsAuth] = useState(false);
  // showMgmtModal: separately gated so the inline banner doesn't auto-show the modal.
  const [showMgmtModal, setShowMgmtModal] = useState(false);
  const [selectedAdminIdx, setSelectedAdminIdx] = useState<number | null>(null);

  // ── Shared search ─────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");

  // ── Calls data load ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchAudit({ limit: 200 });
        if (!cancelled) {
          setRows(data);
          setCallsError(null);
        }
      } catch (e) {
        if (!cancelled) setCallsError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setCallsLoading(false);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ── Admin data load ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchAdminAudit({ limit: 200 });
        if (!cancelled) {
          setAdminRows(data.rows);
          setAdminError(null);
          setAdminNeedsAuth(false);
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof MgmtAuthError) {
            setAdminNeedsAuth(true);
          } else {
            setAdminError(e instanceof Error ? e.message : String(e));
          }
        }
      } finally {
        if (!cancelled) setAdminLoading(false);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // ── Calls filter ──────────────────────────────────────────────────────────
  const filteredCalls = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
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
  }, [rows, outcome, query]);

  // ── Admin filter ──────────────────────────────────────────────────────────
  const filteredAdmin = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return adminRows;
    return adminRows.filter((r) => {
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
  }, [adminRows, query]);

  const selectedCall = selectedCallIdx !== null ? filteredCalls[selectedCallIdx] ?? null : null;
  const selectedAdmin = selectedAdminIdx !== null ? filteredAdmin[selectedAdminIdx] ?? null : null;

  const callCounts = useMemo(() => {
    const c = { ok: 0, denied: 0, error: 0, egress_blocked: 0 };
    for (const r of rows) c[r.outcome]++;
    return c;
  }, [rows]);

  const searchPlaceholder =
    view === "admin"
      ? "filter actor / action / target / reason…"
      : "filter label / path / model / reason…";

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 20 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 16,
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>
            Audit
          </h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {view === "calls"
              ? `${filteredCalls.length} of ${rows.length} calls · last 200 · refreshes every 10s`
              : `${filteredAdmin.length} of ${adminRows.length} admin actions · last 200 · refreshes every 10s`}
          </span>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          style={{
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            padding: "8px 12px",
            fontSize: 13,
            fontFamily: "inherit",
            outline: "none",
            minWidth: 280,
          }}
        />
      </header>

      {/* ── Tab strip ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 4 }}>
        <TabButton label="Calls" active={view === "calls"} onClick={() => setView("calls")} />
        <TabButton label="Admin actions" active={view === "admin"} onClick={() => setView("admin")} />
      </div>

      {/* ── Calls outcome pills (hidden in admin view) ─────────────────────── */}
      {view === "calls" ? (
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 12,
          }}
        >
          <OutcomePill label="All" count={rows.length} active={outcome === "all"} onClick={() => setOutcome("all")} tone="default" />
          <OutcomePill label="OK" count={callCounts.ok} active={outcome === "ok"} onClick={() => setOutcome("ok")} tone="ok" />
          <OutcomePill label="Denied" count={callCounts.denied} active={outcome === "denied"} onClick={() => setOutcome("denied")} tone="denied" />
          <OutcomePill label="Error" count={callCounts.error} active={outcome === "error"} onClick={() => setOutcome("error")} tone="error" />
          <OutcomePill
            label="Egress blocked"
            count={callCounts.egress_blocked}
            active={outcome === "egress_blocked"}
            onClick={() => setOutcome("egress_blocked")}
            tone="egress_blocked"
          />
        </section>
      ) : null}

      {/* ── Calls view ────────────────────────────────────────────────────── */}
      {view === "calls" ? (
        <>
          {callsError ? (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                padding: 16,
                color: "var(--danger)",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
              }}
            >
              /audit failed: {callsError}
            </div>
          ) : null}

          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 0.8fr 0.8fr 1.4fr 0.6fr 0.6fr 0.8fr 0.7fr",
                padding: "10px 16px",
                background: "var(--bg-paper)",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              <span>Time · label</span>
              <span>Provider</span>
              <span>Method</span>
              <span>Path</span>
              <span style={{ textAlign: "right" }}>Status</span>
              <span style={{ textAlign: "right" }}>TTFT</span>
              <span style={{ textAlign: "right" }}>Cost</span>
              <span>Outcome</span>
            </div>
            {callsLoading ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>loading…</div>
            ) : filteredCalls.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>no rows match</div>
            ) : (
              filteredCalls.map((r, i) => (
                <AuditRowView key={`${r.ts}-${r.tokenId}-${i}`} row={r} onClick={() => setSelectedCallIdx(i)} />
              ))
            )}
          </div>
        </>
      ) : null}

      {/* ── Admin view ────────────────────────────────────────────────────── */}
      {view === "admin" ? (
        <>
          {adminNeedsAuth ? (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius)",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Admin audit requires a management token (
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>brkm_…</code>
                ).
              </span>
              <button
                onClick={() => setShowMgmtModal(true)}
                style={{
                  background: "var(--accent)",
                  color: "var(--bg-ink)",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: "var(--radius-sm)",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Set management token
              </button>
            </div>
          ) : adminError ? (
            <div
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                padding: 16,
                color: "var(--danger)",
                fontSize: 13,
                fontFamily: "var(--font-mono)",
              }}
            >
              /admin/audit failed: {adminError}
            </div>
          ) : null}

          <div
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.6fr 1fr 1.4fr 0.8fr",
                padding: "10px 16px",
                background: "var(--bg-paper)",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              <span>Time · actor</span>
              <span>Action</span>
              <span>Target</span>
              <span>Outcome</span>
            </div>
            {adminLoading && !adminNeedsAuth ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>loading…</div>
            ) : adminNeedsAuth ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>
                management token required — set it above to view admin actions
              </div>
            ) : filteredAdmin.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>no rows match</div>
            ) : (
              filteredAdmin.map((r, i) => (
                <AdminAuditRowView
                  key={`${r.ts}-${r.actorTokenId}-${i}`}
                  row={r}
                  onClick={() => setSelectedAdminIdx(i)}
                />
              ))
            )}
          </div>
        </>
      ) : null}

      {/* ── Side panels ───────────────────────────────────────────────────── */}
      {view === "calls" && selectedCall ? (
        <AuditDetail row={selectedCall} onClose={() => setSelectedCallIdx(null)} />
      ) : null}
      {view === "admin" && selectedAdmin ? (
        <AdminAuditDetail row={selectedAdmin} onClose={() => setSelectedAdminIdx(null)} />
      ) : null}

      {/* ── Mgmt token modal (shown when operator clicks "Set management token") */}
      {showMgmtModal ? (
        <MgmtTokenModal
          onConfirmed={() => {
            setShowMgmtModal(false);
            setAdminNeedsAuth(false);
            setAdminLoading(true);
            void fetchAdminAudit({ limit: 200 }).then((data) => {
              setAdminRows(data.rows);
              setAdminError(null);
              setAdminLoading(false);
            }).catch((e) => {
              if (e instanceof MgmtAuthError) {
                setAdminNeedsAuth(true);
              } else {
                setAdminError(e instanceof Error ? e.message : String(e));
              }
              setAdminLoading(false);
            });
          }}
          onCancel={() => setShowMgmtModal(false)}
        />
      ) : null}
    </div>
  );
}

// ── Tab strip button ──────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--bg-elevated)" : "transparent",
        border: `1px solid ${active ? "var(--border-focus)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "7px 16px",
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
      }}
    >
      {label}
    </button>
  );
}

// ── Outcome pill (calls view only) ────────────────────────────────────────────

function OutcomePill({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone: "default" | "ok" | "denied" | "error" | "egress_blocked";
}) {
  const colors: Record<typeof tone, string> = {
    default: "var(--text-primary)",
    ok: "var(--success)",
    denied: "var(--warning)",
    error: "var(--danger)",
    egress_blocked: "var(--accent-rose)",
  };
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "var(--bg-elevated)" : "var(--bg-surface)",
        border: `1px solid ${active ? "var(--border-focus)" : "var(--border-subtle)"}`,
        borderLeft: `3px solid ${colors[tone]}`,
        borderRadius: "var(--radius-sm)",
        padding: "10px 14px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: colors[tone], fontFamily: "var(--font-mono)" }}>
        {count.toLocaleString()}
      </div>
    </button>
  );
}

// ── Calls row ─────────────────────────────────────────────────────────────────

function AuditRowView({ row, onClick }: { row: AuditRow; onClick: () => void }) {
  const cost = row.actualCostUsd ?? row.estimatedCostUsd;
  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 0.8fr 0.8fr 1.4fr 0.6fr 0.6fr 0.8fr 0.7fr",
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 12,
        alignItems: "center",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ color: "var(--text-primary)" }} className="truncate">
          {row.label}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }} className="truncate">
          {fmtTs(row.ts)}
        </span>
      </div>
      <span style={{ color: "var(--text-secondary)" }}>{row.provider}</span>
      <span style={{ color: "var(--text-secondary)" }}>{row.method}</span>
      <span className="truncate" style={{ color: "var(--text-secondary)" }}>
        {row.path}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-primary)" }}>{row.status}</span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>
        {row.ttftMs !== undefined ? `${row.ttftMs}ms` : "—"}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)" }}>
        {cost !== undefined ? fmtUsd(cost) : "—"}
      </span>
      <span style={{ color: outcomeColor[row.outcome], fontWeight: 700 }}>{row.outcome}</span>
    </div>
  );
}

// ── Admin row ─────────────────────────────────────────────────────────────────

function AdminAuditRowView({
  row,
  onClick,
}: {
  row: AdminAuditRow;
  onClick: () => void;
}) {
  const target = row.targetTokenId
    ? row.targetTokenId
    : row.targetCount !== undefined
      ? `${row.targetCount} tokens`
      : "—";

  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "1.6fr 1fr 1.4fr 0.8fr",
        padding: "10px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 12,
        alignItems: "center",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ color: "var(--text-primary)" }} className="truncate">
          {row.actorLabel ?? "(unknown)"}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }} className="truncate">
          {fmtTs(row.ts)}
        </span>
      </div>
      <span style={{ color: adminActionColor[row.action], fontWeight: 600 }}>
        {row.action}
      </span>
      <span className="truncate" style={{ color: "var(--text-secondary)" }}>
        {target}
      </span>
      <span
        style={{
          color: adminOutcomeColor[row.outcome],
          fontWeight: 700,
        }}
      >
        {row.outcome}
      </span>
    </div>
  );
}

// ── Calls detail panel ────────────────────────────────────────────────────────

function AuditDetail({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: 460,
        background: "var(--bg-paper)",
        borderLeft: "1px solid var(--border-subtle)",
        boxShadow: "var(--shadow)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        overflow: "auto",
      }}
      className="anim-fade"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{row.label}</h2>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {fmtTs(row.ts)}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: 4,
          }}
          aria-label="close"
        >
          ×
        </button>
      </div>
      <Row label="Outcome" value={row.outcome} color={outcomeColor[row.outcome]} />
      {row.reason ? <Row label="Reason" value={row.reason} /> : null}
      <Row label="Token id" value={row.tokenId} />
      <Row label="Provider" value={row.provider} />
      <Row label="Method · path" value={`${row.method} ${row.path}`} />
      <Row label="Status" value={String(row.status)} />
      <Row label="Duration" value={`${row.durationMs} ms`} />
      {row.ttftMs !== undefined ? <Row label="TTFT" value={`${row.ttftMs} ms`} /> : null}
      {row.tpotMsAvg !== undefined ? (
        <Row label="TPOT (mean)" value={`${row.tpotMsAvg.toFixed(2)} ms`} />
      ) : null}
      {row.outputTokens !== undefined ? (
        <Row label="Output tokens" value={String(row.outputTokens)} />
      ) : null}
      <Row label="Req bytes" value={row.reqBytes.toLocaleString()} />
      <Row label="Resp bytes" value={row.respBytes.toLocaleString()} />
      {row.requestedModel ? <Row label="Requested model" value={row.requestedModel} /> : null}
      {row.estimatedCostUsd !== undefined ? (
        <Row label="Estimated cost" value={fmtUsd(row.estimatedCostUsd)} />
      ) : null}
      {row.actualCostUsd !== undefined ? (
        <Row label="Actual cost" value={fmtUsd(row.actualCostUsd)} />
      ) : null}
      {row.machine ? <Row label="Machine" value={row.machine} /> : null}
      {row.tagTeam ? <Row label="Team" value={row.tagTeam} /> : null}
      {row.tagProject ? <Row label="Project" value={row.tagProject} /> : null}
      {row.tagEnv ? <Row label="Env" value={row.tagEnv} /> : null}
    </div>
  );
}

// ── Admin audit detail panel ──────────────────────────────────────────────────

function AdminAuditDetail({
  row,
  onClose,
}: {
  row: AdminAuditRow;
  onClose: () => void;
}) {
  const parsedParams = useMemo(() => {
    if (!row.paramsJson) return null;
    try {
      return JSON.stringify(JSON.parse(row.paramsJson), null, 2);
    } catch {
      return row.paramsJson;
    }
  }, [row.paramsJson]);

  const target = row.targetTokenId
    ? row.targetTokenId
    : row.targetCount !== undefined
      ? `${row.targetCount} tokens rotated`
      : "—";

  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: 460,
        background: "var(--bg-paper)",
        borderLeft: "1px solid var(--border-subtle)",
        boxShadow: "var(--shadow)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        overflow: "auto",
      }}
      className="anim-fade"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            {row.actorLabel ?? "(unknown actor)"}
          </h2>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {fmtTs(row.ts)}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 18,
            cursor: "pointer",
            padding: 4,
          }}
          aria-label="close"
        >
          ×
        </button>
      </div>
      <Row label="Actor (mgmt id)" value={row.actorTokenId} />
      <Row
        label="Action"
        value={row.action}
        color={adminActionColor[row.action]}
      />
      <Row label="Target" value={target} />
      <Row
        label="Outcome"
        value={row.outcome}
        color={adminOutcomeColor[row.outcome]}
      />
      {row.reason ? <Row label="Reason" value={row.reason} /> : null}
      <Row label="Time" value={fmtTs(row.ts)} />
      {row.sourceIp ? <Row label="Source IP" value={row.sourceIp} /> : null}
      {row.userAgent ? <Row label="User agent" value={row.userAgent} /> : null}
      {parsedParams ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            Params
          </span>
          <pre
            style={{
              margin: 0,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              padding: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {parsedParams}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

// ── Shared detail row ─────────────────────────────────────────────────────────

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: color ?? "var(--text-primary)",
          fontFamily: "var(--font-mono)",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}
