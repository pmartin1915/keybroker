import { useEffect, useState } from "react";
import { fetchPolicy, type PolicySnapshot } from "../api/client.js";

const REFRESH_MS = 30_000;

export function PolicyScreen() {
  const [policy, setPolicy] = useState<PolicySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchPolicy();
        if (!cancelled) {
          setPolicy(data);
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

  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 20 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" }}>Policy</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Active fleet guardrails · refreshes every 30s · read-only
        </span>
      </header>

      {error ? (
        <Banner tone="danger">/policy failed: {error}</Banner>
      ) : null}

      {!loading && policy ? (
        <>
          <PolicyCard
            title="Scanner"
            subtitle="Inline secret detection on outbound prompts (Phase 3.6)"
            highlight={policy.scanner.enabled}
          >
            <KV
              label="Master switch"
              value={policy.scanner.enabled ? "enabled" : "disabled"}
              tone={policy.scanner.enabled ? "good" : "danger"}
            />
            <KV
              label="Detectors"
              value={
                policy.scanner.detectors === undefined
                  ? "all built-ins"
                  : policy.scanner.detectors.length === 0
                    ? "(empty — nothing will scan)"
                    : policy.scanner.detectors.join(", ")
              }
            />
            <Footnote>
              When the scanner fires, the request is blocked (outcome <code>egress_blocked</code>) and
              never reaches upstream. The audit row carries the detector name as <code>reason</code>;
              the matched bytes are never logged.
            </Footnote>
          </PolicyCard>

          <PolicyCard title="Forbidden models" subtitle="Glob patterns checked against the request body's model field">
            {policy.forbiddenModels.length === 0 ? (
              <Empty>none — only per-token <code>mdl</code> claims apply</Empty>
            ) : (
              <PillList items={policy.forbiddenModels} tone="danger" />
            )}
          </PolicyCard>

          <PolicyCard
            title="Allowed providers"
            subtitle="When set, every other provider is refused regardless of token claim"
          >
            {policy.allowedProviders.length === 0 ? (
              <Empty>no restriction (token's <code>prv</code> claim governs)</Empty>
            ) : (
              <PillList items={policy.allowedProviders} tone="good" />
            )}
          </PolicyCard>

          <PolicyCard
            title="Tag allow-list"
            subtitle="Per-tag value restrictions checked at issue time"
          >
            <TagAllowList rows={policy.tagAllowlist} />
            <Footnote>
              Tags omitted from the allow-list accept any non-empty short string. An explicit empty
              array is treated as "key omitted" — see policy.ts for the rationale.
            </Footnote>
          </PolicyCard>
        </>
      ) : (
        <Banner tone="muted">{loading ? "loading…" : "no policy data"}</Banner>
      )}
    </div>
  );
}

function PolicyCard({
  title,
  subtitle,
  highlight,
  children,
}: {
  title: string;
  subtitle?: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: "var(--bg-surface)",
        border: `1px solid ${highlight ? "var(--accent-lime-dim)" : "var(--border-subtle)"}`,
        borderRadius: "var(--radius)",
        padding: "18px 20px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{title}</div>
        {subtitle ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{subtitle}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function KV({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "danger";
}) {
  const colors = {
    default: "var(--text-primary)",
    good: "var(--success)",
    danger: "var(--danger)",
  } as const;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: 12,
        fontSize: 12,
        alignItems: "baseline",
      }}
    >
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
          fontFamily: "var(--font-mono)",
          color: colors[tone],
          fontWeight: tone === "good" || tone === "danger" ? 700 : 400,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PillList({ items, tone }: { items: readonly string[]; tone: "good" | "danger" }) {
  const border = tone === "good" ? "var(--success)" : "var(--danger)";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((p) => (
        <span
          key={p}
          style={{
            display: "inline-flex",
            alignItems: "center",
            background: "var(--bg-elevated)",
            border: `1px solid ${border}`,
            borderRadius: 4,
            padding: "3px 8px",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--text-primary)",
          }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}

function TagAllowList({
  rows,
}: {
  rows: { team?: readonly string[]; project?: readonly string[]; env?: readonly string[] };
}) {
  const entries = (["team", "project", "env"] as const).map((k) => ({
    k,
    v: rows[k] ?? [],
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {entries.map(({ k, v }) => (
        <div
          key={k}
          style={{
            display: "grid",
            gridTemplateColumns: "100px 1fr",
            gap: 12,
            alignItems: "center",
            fontSize: 12,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            {k}
          </span>
          {v.length === 0 ? (
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              (any value)
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {v.map((tag) => (
                <span
                  key={tag}
                  style={{
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 4,
                    padding: "3px 8px",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-primary)",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{children}</span>;
}

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        fontSize: 11,
        color: "var(--text-muted)",
        lineHeight: 1.5,
        borderLeft: "2px solid var(--border-subtle)",
        paddingLeft: 10,
      }}
    >
      {children}
    </p>
  );
}

function Banner({ tone, children }: { tone: "danger" | "muted"; children: React.ReactNode }) {
  const colors = {
    danger: { bg: "var(--bg-surface)", border: "var(--danger)", text: "var(--danger)" },
    muted: { bg: "var(--bg-surface)", border: "var(--border-subtle)", text: "var(--text-muted)" },
  } as const;
  return (
    <div
      style={{
        background: colors[tone].bg,
        border: `1px solid ${colors[tone].border}`,
        borderRadius: "var(--radius)",
        padding: 16,
        color: colors[tone].text,
        fontSize: 13,
        fontFamily: "var(--font-mono)",
      }}
    >
      {children}
    </div>
  );
}
