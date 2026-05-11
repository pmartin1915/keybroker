import type { TagSpendRow } from "../api/client.js";

interface Props {
  title: string;
  data: TagSpendRow[];
  loading: boolean;
  error: string | null;
}

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function TagSpendCard({ title, data, loading, error }: Props) {
  const total = data.reduce((a, r) => a + r.usd, 0);
  const max = data.reduce((m, r) => Math.max(m, r.usd), 0);
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 220,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
          {fmtUsd(total)} total
        </span>
      </div>
      {loading ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>loading…</span>
      ) : error ? (
        <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>
      ) : data.length === 0 ? (
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>no priced calls in window</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.map((row) => {
            const pct = max === 0 ? 0 : (row.usd / max) * 100;
            return (
              <div key={row.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{row.key}</span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    {fmtUsd(row.usd)} · {row.callCount.toLocaleString()} calls
                  </span>
                </div>
                <div
                  style={{
                    height: 4,
                    background: "var(--bg-elevated)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      background: "var(--accent)",
                      transition: "width 0.3s",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
