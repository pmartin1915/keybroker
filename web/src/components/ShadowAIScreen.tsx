import { useEffect, useMemo, useState } from "react";
import { fetchAudit, type AuditRow } from "../api/client.js";

const REFRESH_MS = 15_000;

const fmtTs = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
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

export function ShadowAIScreen() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Pull a generous slice; we filter to egress_blocked locally.
        // The broker's /audit has no outcome filter — see c2 decision 2.
        const data = await fetchAudit({ limit: 500 });
        if (!cancelled) {
          setRows(data.filter((r) => r.outcome === "egress_blocked"));
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

  const buckets = useMemo<DetectorBucket[]>(() => {
    const m = new Map<string, DetectorBucket>();
    for (const r of rows) {
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
  }, [rows]);

  const selectedBucket = selected ? buckets.find((b) => b.name === selected) ?? null : null;

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
            Shadow AI
          </h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {rows.length} egress-blocked event{rows.length === 1 ? "" : "s"} · refreshes every 15s
          </span>
        </div>
      </header>

      <Footnote>
        Every row below is a prompt the broker refused to forward upstream. The detector matched
        secret material in the request body and the call was rejected before any byte left the
        machine. <strong>The matched substring is never logged</strong> — only the detector name.
      </Footnote>

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

      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>loading…</span>
      ) : buckets.length === 0 ? (
        <EmptyState />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          {buckets.map((b) => (
            <DetectorCard
              key={b.name}
              bucket={b}
              active={selected === b.name}
              onClick={() => setSelected(selected === b.name ? null : b.name)}
            />
          ))}
        </div>
      )}

      {selectedBucket ? <DetectorDetail bucket={selectedBucket} /> : null}
    </div>
  );
}

function DetectorCard({
  bucket,
  active,
  onClick,
}: {
  bucket: DetectorBucket;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "var(--bg-surface)",
        border: `1px solid ${active ? "var(--accent-rose)" : "var(--border-subtle)"}`,
        borderLeft: "3px solid var(--accent-rose)",
        borderRadius: "var(--radius)",
        padding: "16px 18px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--accent-rose)",
        }}
      >
        {bucket.name}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          color: "var(--text-primary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {bucket.count.toLocaleString()}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
        {bucket.uniqueTokens.size} token{bucket.uniqueTokens.size === 1 ? "" : "s"} ·{" "}
        {bucket.uniqueMachines.size} machine{bucket.uniqueMachines.size === 1 ? "" : "s"}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
        last: {fmtTs(bucket.lastSeen)}
      </div>
    </button>
  );
}

function DetectorDetail({ bucket }: { bucket: DetectorBucket }) {
  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
      className="anim-fade"
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--accent-rose)",
          }}
        >
          Detector: {bucket.name}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          {bucket.rows.length} event{bucket.rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 0.8fr 0.8fr 1fr 1fr",
          padding: "8px 12px",
          background: "var(--bg-paper)",
          borderRadius: 6,
          fontSize: 10,
          fontWeight: 700,
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        <span>Time</span>
        <span>Token label</span>
        <span>Machine</span>
        <span>Provider · path</span>
        <span>Tags</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 380, overflow: "auto" }}>
        {bucket.rows.map((r, i) => (
          <div
            key={`${r.ts}-${r.tokenId}-${i}`}
            style={{
              display: "grid",
              gridTemplateColumns: "1.2fr 0.8fr 0.8fr 1fr 1fr",
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
              background: i % 2 === 0 ? "var(--bg-elevated)" : "transparent",
            }}
          >
            <span className="truncate">{fmtTs(r.ts)}</span>
            <span style={{ color: "var(--text-primary)" }} className="truncate">
              {r.label}
            </span>
            <span className="truncate">{r.machine ?? "—"}</span>
            <span className="truncate">
              {r.provider} {r.path}
            </span>
            <span className="truncate">
              {[r.tagTeam, r.tagProject, r.tagEnv].filter(Boolean).join(" · ") || "—"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyState() {
  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "32px 24px",
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 14,
          color: "var(--success)",
          fontWeight: 700,
          letterSpacing: "0.02em",
        }}
      >
        No secrets caught in the last 500 calls.
      </span>
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        The scanner runs on every outbound prompt. When something fires it shows up here grouped by
        detector.
      </span>
    </section>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 12,
        color: "var(--text-secondary)",
        lineHeight: 1.55,
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderLeft: "3px solid var(--accent-rose)",
        borderRadius: "var(--radius-sm)",
        padding: "10px 14px",
      }}
    >
      {children}
    </p>
  );
}
