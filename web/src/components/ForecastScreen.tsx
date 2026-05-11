import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchTagForecast,
  fetchTokenForecast,
  type TagBucket,
  type TagForecastRow,
  type TokenForecastRow,
} from "../api/client.js";

const REFRESH_MS = 30_000;

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDays = (n: number | undefined) => {
  if (n === undefined) return "—";
  if (n === 0) return "now";
  if (n < 1) return `${Math.round(n * 24)}h`;
  if (n < 30) return `${n.toFixed(1)}d`;
  return `${Math.round(n)}d`;
};

export function ForecastScreen() {
  const [tokens, setTokens] = useState<TokenForecastRow[]>([]);
  const [tags, setTags] = useState<TagForecastRow[]>([]);
  const [bucket, setBucket] = useState<TagBucket>("team");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [tok, tg] = await Promise.all([
          fetchTokenForecast({ since: "14d", top: 20 }),
          fetchTagForecast(bucket, { since: "14d", top: 10 }),
        ]);
        if (!cancelled) {
          setTokens(tok);
          setTags(tg);
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
  }, [bucket]);

  const burnLeaders = useMemo(
    () =>
      [...tokens]
        .filter((t) => t.slopeUsdPerDay > 0)
        .sort((a, b) => b.slopeUsdPerDay - a.slopeUsdPerDay)
        .slice(0, 8),
    [tokens],
  );

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
            Forecast
          </h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            14-day burn rate · refreshes every 30s
          </span>
        </div>
      </header>

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
          forecast failed: {error}
        </div>
      ) : null}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 16,
        }}
      >
        <Card
          title="Tokens projected to breach cap"
          subtitle="ordered by days-until-breach ascending"
        >
          {loading ? (
            <Empty>loading…</Empty>
          ) : tokens.length === 0 ? (
            <Empty>no tokens in window</Empty>
          ) : (
            <TokenBreachTable rows={tokens} />
          )}
        </Card>
        <Card title="Burn leaders (USD/day)" subtitle="slope of cumulative spend">
          {loading ? (
            <Empty>loading…</Empty>
          ) : burnLeaders.length === 0 ? (
            <Empty>no burn detected</Empty>
          ) : (
            <BurnChart rows={burnLeaders} />
          )}
        </Card>
      </section>

      <Card
        title="Tag burn rate"
        subtitle="USD/day by tag value over the 14-day window"
        action={<BucketPills bucket={bucket} setBucket={setBucket} />}
      >
        {loading ? (
          <Empty>loading…</Empty>
        ) : tags.length === 0 ? (
          <Empty>no tagged spend in window</Empty>
        ) : (
          <TagBurnChart rows={tags} />
        )}
      </Card>
    </div>
  );
}

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
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
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{title}</span>
          {subtitle ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{subtitle}</span>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{children}</span>;
}

function BucketPills({
  bucket,
  setBucket,
}: {
  bucket: TagBucket;
  setBucket: (b: TagBucket) => void;
}) {
  const opts: TagBucket[] = ["team", "project", "env"];
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--bg-elevated)",
        borderRadius: "var(--radius-sm)",
        padding: 2,
      }}
    >
      {opts.map((b) => {
        const active = b === bucket;
        return (
          <button
            key={b}
            onClick={() => setBucket(b)}
            style={{
              background: active ? "var(--bg-paper)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              border: "none",
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              borderRadius: 4,
              fontFamily: "inherit",
              textTransform: "lowercase",
            }}
          >
            {b}
          </button>
        );
      })}
    </div>
  );
}

function TokenBreachTable({ rows }: { rows: TokenForecastRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflow: "auto" }}>
      {rows.map((r) => {
        const breaching = r.daysUntilCap !== undefined;
        const tone = !breaching
          ? "var(--text-muted)"
          : r.daysUntilCap! < 1
            ? "var(--danger)"
            : r.daysUntilCap! < 7
              ? "var(--warning)"
              : "var(--accent)";
        return (
          <div
            key={r.tokenId}
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr 0.7fr 0.7fr 0.7fr",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 6,
              background: "var(--bg-elevated)",
              fontSize: 12,
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ color: "var(--text-primary)", fontWeight: 600 }} className="truncate">
                {r.label}
              </span>
              <span
                style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
                className="truncate"
              >
                {r.provider}
                {r.tagTeam ? ` · ${r.tagTeam}` : ""}
              </span>
            </div>
            <span
              style={{
                textAlign: "right",
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
              }}
            >
              {fmtUsd(r.slopeUsdPerDay)}/d
            </span>
            <span
              style={{
                textAlign: "right",
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
              }}
            >
              {r.capUsd ? `${fmtUsd(r.currentUsd)} / ${fmtUsd(r.capUsd)}` : fmtUsd(r.currentUsd)}
            </span>
            <span
              style={{
                textAlign: "right",
                fontFamily: "var(--font-mono)",
                color: tone,
                fontWeight: 700,
              }}
            >
              {fmtDays(r.daysUntilCap)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BurnChart({ rows }: { rows: TokenForecastRow[] }) {
  const data = rows.map((r) => ({
    label: r.label.length > 14 ? r.label.slice(0, 12) + "…" : r.label,
    usdPerDay: Math.round(r.slopeUsdPerDay * 100) / 100,
  }));
  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 24, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis
            dataKey="label"
            stroke="var(--text-muted)"
            tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
            angle={-30}
            textAnchor="end"
            height={50}
          />
          <YAxis
            stroke="var(--text-muted)"
            tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            cursor={{ fill: "var(--bg-elevated)" }}
            contentStyle={{
              background: "var(--bg-paper)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number) => [`${fmtUsd(v)}/d`, "burn"]}
          />
          <Bar dataKey="usdPerDay" fill="var(--accent)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TagBurnChart({ rows }: { rows: TagForecastRow[] }) {
  const data = rows.map((r) => ({
    key: r.key,
    usdPerDay: Math.round(r.slopeUsdPerDay * 100) / 100,
    currentUsd: Math.round(r.currentUsd * 100) / 100,
  }));
  return (
    <div style={{ height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 8 }} layout="vertical">
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
          <XAxis
            type="number"
            stroke="var(--text-muted)"
            tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
            tickFormatter={(v: number) => `$${v}`}
          />
          <YAxis
            type="category"
            dataKey="key"
            stroke="var(--text-muted)"
            tick={{ fontSize: 11, fill: "var(--text-secondary)" }}
            width={100}
          />
          <Tooltip
            cursor={{ fill: "var(--bg-elevated)" }}
            contentStyle={{
              background: "var(--bg-paper)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v: number, name) =>
              name === "usdPerDay" ? [`${fmtUsd(v)}/d`, "burn"] : [fmtUsd(v), "current"]
            }
          />
          <Bar dataKey="usdPerDay" fill="var(--accent-cyan)" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
