import { useEffect, useMemo, useState } from "react";
import { fetchAudit, type AuditRow } from "../api/client.js";

const REFRESH_MS = 10_000;

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const fmtTs = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

type OutcomeFilter = "all" | "ok" | "denied" | "error" | "egress_blocked";

const outcomeColor: Record<AuditRow["outcome"], string> = {
  ok: "var(--success)",
  denied: "var(--warning)",
  error: "var(--danger)",
  egress_blocked: "var(--accent-rose)",
};

export function AuditScreen() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchAudit({ limit: 200 });
        if (!cancelled) {
          setRows(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const filtered = useMemo(() => {
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

  const selected = selectedIdx !== null ? filtered[selectedIdx] ?? null : null;
  const counts = useMemo(() => {
    const c = { ok: 0, denied: 0, error: 0, egress_blocked: 0 };
    for (const r of rows) c[r.outcome]++;
    return c;
  }, [rows]);

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
            {filtered.length} of {rows.length} calls · last 200 · refreshes every 10s
          </span>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter label / path / model / reason…"
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

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
        }}
      >
        <OutcomePill label="All" count={rows.length} active={outcome === "all"} onClick={() => setOutcome("all")} tone="default" />
        <OutcomePill label="OK" count={counts.ok} active={outcome === "ok"} onClick={() => setOutcome("ok")} tone="ok" />
        <OutcomePill label="Denied" count={counts.denied} active={outcome === "denied"} onClick={() => setOutcome("denied")} tone="denied" />
        <OutcomePill label="Error" count={counts.error} active={outcome === "error"} onClick={() => setOutcome("error")} tone="error" />
        <OutcomePill
          label="Egress blocked"
          count={counts.egress_blocked}
          active={outcome === "egress_blocked"}
          onClick={() => setOutcome("egress_blocked")}
          tone="egress_blocked"
        />
      </section>

      {error ? (
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
          /audit failed: {error}
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
        {loading ? (
          <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>no rows match</div>
        ) : (
          filtered.map((r, i) => (
            <AuditRowView key={`${r.ts}-${r.tokenId}-${i}`} row={r} onClick={() => setSelectedIdx(i)} />
          ))
        )}
      </div>

      {selected ? <AuditDetail row={selected} onClose={() => setSelectedIdx(null)} /> : null}
    </div>
  );
}

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
