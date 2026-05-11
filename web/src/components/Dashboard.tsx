import { useEffect, useState } from "react";
import {
  fetchHealth,
  fetchSpend,
  type HealthResponse,
  type TagSpendRow,
} from "../api/client.js";
import { StatCard } from "./StatCard.js";
import { TagSpendCard } from "./TagSpendCard.js";

const REFRESH_MS = 10_000;

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface BucketState {
  data: TagSpendRow[];
  loading: boolean;
  error: string | null;
}

function emptyBucket(): BucketState {
  return { data: [], loading: true, error: null };
}

export function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [team, setTeam] = useState<BucketState>(emptyBucket());
  const [project, setProject] = useState<BucketState>(emptyBucket());
  const [env, setEnv] = useState<BucketState>(emptyBucket());
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const h = await fetchHealth();
        if (!cancelled) {
          setHealth(h);
          setHealthError(null);
        }
      } catch (e) {
        if (!cancelled) setHealthError(e instanceof Error ? e.message : String(e));
      }

      const buckets: Array<["team" | "project" | "env", (s: BucketState) => void]> = [
        ["team", setTeam],
        ["project", setProject],
        ["env", setEnv],
      ];
      await Promise.all(
        buckets.map(async ([b, setter]) => {
          try {
            const rows = await fetchSpend(b, "24h", 10);
            if (!cancelled) setter({ data: rows, loading: false, error: null });
          } catch (e) {
            if (!cancelled)
              setter({
                data: [],
                loading: false,
                error: e instanceof Error ? e.message : String(e),
              });
          }
        }),
      );
      if (!cancelled) setLastRefresh(Date.now());
    };

    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const machineRows = health
    ? Object.entries(health.calls.last24hSpendUsdByMachine).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 24 }}>
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
            Dashboard
          </h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Last 24 hours · refreshes every 10s
          </span>
        </div>
        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          updated {new Date(lastRefresh).toLocaleTimeString()}
        </span>
      </header>

      {healthError ? (
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
          /health failed: {healthError}
        </div>
      ) : null}

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 16,
        }}
      >
        <StatCard
          label="Active tokens"
          value={health ? health.tokens.active : "—"}
          hint={health ? `${health.tokens.revoked} revoked` : undefined}
        />
        <StatCard
          label="Calls (24h)"
          value={health ? health.calls.last24h.toLocaleString() : "—"}
        />
        <StatCard
          label="Spend (24h)"
          value={health ? fmtUsd(health.calls.last24hSpendUsd) : "—"}
          tone="accent"
        />
        <StatCard
          label="Broker"
          value={health ? (health.keybroker_ok ? "OK" : "DEGRADED") : "—"}
          hint={health ? `v${health.version}` : undefined}
          tone={health?.keybroker_ok ? "accent" : "danger"}
        />
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        <TagSpendCard title="Spend by team" data={team.data} loading={team.loading} error={team.error} />
        <TagSpendCard
          title="Spend by project"
          data={project.data}
          loading={project.loading}
          error={project.error}
        />
        <TagSpendCard title="Spend by env" data={env.data} loading={env.loading} error={env.error} />
      </section>

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
      >
        <span style={{ fontSize: 13, fontWeight: 600 }}>Spend by machine (24h)</span>
        {machineRows.length === 0 ? (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>no priced calls</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {machineRows.map(([machine, usd]) => (
              <div
                key={machine || "(none)"}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-secondary)",
                }}
              >
                <span style={{ color: "var(--text-primary)" }}>{machine || "(unattributed)"}</span>
                <span>{fmtUsd(usd)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
