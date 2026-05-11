import { useEffect, useMemo, useState } from "react";
import {
  fetchTokens,
  revokeProxyToken,
  MgmtAuthError,
  type TokenRow,
} from "../api/client.js";
import { MgmtTokenModal } from "./MgmtTokenModal.js";
import { IssueTokenModal } from "./IssueTokenModal.js";

const REFRESH_MS = 15_000;

const fmtUsd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtExpiry = (epoch: number): string => {
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
};

type Filter = "all" | "active" | "revoked";

// Phase 4.0 c4: which write action initiated the auth prompt. Tracks
// so an auth retry can resume the original intent (open the issue
// modal once the token's saved, or revoke the previously-selected
// row). `null` = no auth flow in progress.
type PendingAction =
  | { kind: "issue" }
  | { kind: "revoke"; tokenId: string }
  | null;

export function TokensScreen() {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [issueOpen, setIssueOpen] = useState(false);
  const [authPrompt, setAuthPrompt] = useState<{ reason: string } | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchTokens();
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
  }, [refreshTick]);

  const forceRefresh = () => setRefreshTick((n) => n + 1);

  const openIssue = () => {
    setPending({ kind: "issue" });
    setIssueOpen(true);
  };

  const handleRevoke = async (tokenId: string) => {
    setRevokeError(null);
    try {
      await revokeProxyToken(tokenId);
      forceRefresh();
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        setPending({ kind: "revoke", tokenId });
        setAuthPrompt({ reason: e.message });
        return;
      }
      setRevokeError(e instanceof Error ? e.message : String(e));
    }
  };

  const onAuthConfirmed = () => {
    setAuthPrompt(null);
    if (pending?.kind === "issue") {
      setIssueOpen(true);
    } else if (pending?.kind === "revoke") {
      void handleRevoke(pending.tokenId);
    }
  };

  const onIssueAuthNeeded = (reason: string) => {
    setIssueOpen(false);
    setPending({ kind: "issue" });
    setAuthPrompt({ reason });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && r.revoked) return false;
      if (filter === "revoked" && !r.revoked) return false;
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
  }, [rows, filter, query]);

  const selectedRow = selected ? rows.find((r) => r.id === selected) ?? null : null;

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
            Tokens
          </h1>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {filtered.length} of {rows.length} tokens · refreshes every 15s
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter label / id / tag…"
            style={{
              background: "var(--bg-surface)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              padding: "8px 12px",
              fontSize: 13,
              fontFamily: "inherit",
              outline: "none",
              minWidth: 240,
            }}
          />
          <FilterPills filter={filter} setFilter={setFilter} />
          <button
            onClick={openIssue}
            style={{
              background: "var(--accent)",
              color: "var(--bg-ink)",
              border: "none",
              padding: "8px 14px",
              borderRadius: "var(--radius-sm)",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            + Issue token
          </button>
        </div>
      </header>

      {revokeError ? (
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: 12,
            color: "var(--danger)",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          revoke failed: {revokeError}
        </div>
      ) : null}

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
          /tokens failed: {error}
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
            gridTemplateColumns: "1.4fr 0.8fr 1fr 0.6fr 1fr 0.7fr",
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
          <span>Label / id</span>
          <span>Provider</span>
          <span>Tags · machine</span>
          <span style={{ textAlign: "right" }}>Calls</span>
          <span>Spend / cap</span>
          <span style={{ textAlign: "right" }}>Expires</span>
        </div>
        {loading ? (
          <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: "var(--text-muted)" }}>no tokens match</div>
        ) : (
          filtered.map((r) => <TokenRowView key={r.id} row={r} onClick={() => setSelected(r.id)} />)
        )}
      </div>

      {selectedRow ? (
        <TokenDetail
          row={selectedRow}
          onClose={() => setSelected(null)}
          onRevoke={() => void handleRevoke(selectedRow.id)}
        />
      ) : null}

      {issueOpen ? (
        <IssueTokenModal
          onClose={() => {
            setIssueOpen(false);
            setPending(null);
          }}
          onIssued={() => {
            forceRefresh();
          }}
          onNeedsAuth={onIssueAuthNeeded}
        />
      ) : null}

      {authPrompt ? (
        <MgmtTokenModal
          initialReason={authPrompt.reason}
          onConfirmed={onAuthConfirmed}
          onCancel={() => {
            setAuthPrompt(null);
            setPending(null);
          }}
        />
      ) : null}
    </div>
  );
}

function FilterPills({ filter, setFilter }: { filter: Filter; setFilter: (f: Filter) => void }) {
  const options: Array<{ id: Filter; label: string }> = [
    { id: "active", label: "Active" },
    { id: "revoked", label: "Revoked" },
    { id: "all", label: "All" },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        padding: 2,
      }}
    >
      {options.map((o) => {
        const active = o.id === filter;
        return (
          <button
            key={o.id}
            onClick={() => setFilter(o.id)}
            style={{
              background: active ? "var(--bg-elevated)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              border: "none",
              padding: "6px 12px",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              borderRadius: 4,
              fontFamily: "inherit",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function TagPill({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: "2px 6px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)" }}>{value}</span>
    </span>
  );
}

function TokenRowView({ row, onClick }: { row: TokenRow; onClick: () => void }) {
  const cap = row.capUsd;
  const spendPct = cap && cap > 0 ? Math.min(100, (row.spendUsd / cap) * 100) : 0;
  const overCap = cap !== undefined && row.spendUsd > cap;
  return (
    <div
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "1.4fr 0.8fr 1fr 0.6fr 1fr 0.7fr",
        padding: "12px 16px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: 12,
        alignItems: "center",
        cursor: "pointer",
        background: row.revoked ? "rgba(225, 78, 78, 0.04)" : "transparent",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: "var(--text-primary)" }} className="truncate">
          {row.label}
        </span>
        <span
          style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
          className="truncate"
        >
          {row.id}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ color: "var(--text-primary)" }}>{row.provider}</span>
        {row.revoked ? (
          <span style={{ color: "var(--danger)", fontSize: 10, fontWeight: 700 }}>REVOKED</span>
        ) : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {row.tagTeam ? <TagPill label="team" value={row.tagTeam} /> : null}
        {row.tagProject ? <TagPill label="proj" value={row.tagProject} /> : null}
        {row.tagEnv ? <TagPill label="env" value={row.tagEnv} /> : null}
        {row.machine ? <TagPill label="mch" value={row.machine} /> : null}
      </div>
      <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
        {row.used.toLocaleString()}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
          {fmtUsd(row.spendUsd)}
          {cap !== undefined ? ` / ${fmtUsd(cap)}` : null}
        </span>
        {cap !== undefined && cap > 0 ? (
          <div
            style={{
              height: 3,
              background: "var(--bg-elevated)",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${spendPct}%`,
                height: "100%",
                background: overCap ? "var(--danger)" : spendPct > 80 ? "var(--warning)" : "var(--accent)",
              }}
            />
          </div>
        ) : null}
      </div>
      <span
        style={{
          textAlign: "right",
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
        }}
      >
        {fmtExpiry(row.expiresAt)}
      </span>
    </div>
  );
}

function TokenDetail({
  row,
  onClose,
  onRevoke,
}: {
  row: TokenRow;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div
      style={{
        position: "fixed",
        right: 0,
        top: 0,
        bottom: 0,
        width: 420,
        background: "var(--bg-paper)",
        borderLeft: "1px solid var(--border-subtle)",
        boxShadow: "var(--shadow)",
        padding: 24,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        overflow: "auto",
      }}
      className="anim-fade"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{row.label}</h2>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {row.id}
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
      <DetailRow label="Status" value={row.revoked ? "REVOKED" : "active"} mono />
      <DetailRow label="Provider" value={row.provider} mono />
      <DetailRow label="Scopes" value={row.scopes.join(", ")} mono />
      {row.machine ? <DetailRow label="Machine" value={row.machine} mono /> : null}
      {row.tagTeam ? <DetailRow label="Team" value={row.tagTeam} mono /> : null}
      {row.tagProject ? <DetailRow label="Project" value={row.tagProject} mono /> : null}
      {row.tagEnv ? <DetailRow label="Env" value={row.tagEnv} mono /> : null}
      {row.models && row.models.length > 0 ? (
        <DetailRow label="Models" value={row.models.join(", ")} mono />
      ) : null}
      <DetailRow
        label="Spend"
        value={`${fmtUsd(row.spendUsd)}${row.capUsd !== undefined ? ` / ${fmtUsd(row.capUsd)}` : ""}`}
        mono
      />
      <DetailRow label="Calls" value={row.used.toLocaleString()} mono />
      <DetailRow label="Remaining" value={row.remaining === -1 ? "unlimited" : String(row.remaining)} mono />
      <DetailRow label="Expires" value={fmtExpiry(row.expiresAt)} mono />
      <DetailRow label="Created" value={new Date(row.createdAt).toLocaleString()} mono />

      {/* Phase 4.0 c4: revoke affordance. Two-step confirm — first
          click swaps to a danger-tinted "Confirm revoke" button. */}
      {!row.revoked ? (
        <div
          style={{
            marginTop: "auto",
            paddingTop: 16,
            borderTop: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {confirming ? (
            <>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Revoke {row.label}? This is immediate and cannot be undone.
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setConfirming(false)}
                  style={{
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-subtle)",
                    padding: "8px 14px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    flex: 1,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setConfirming(false);
                    onRevoke();
                  }}
                  style={{
                    background: "var(--danger)",
                    color: "var(--bg-ink)",
                    border: "none",
                    padding: "8px 14px",
                    borderRadius: "var(--radius-sm)",
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    flex: 1,
                  }}
                >
                  Confirm revoke
                </button>
              </div>
            </>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              style={{
                background: "transparent",
                color: "var(--danger)",
                border: "1px solid var(--danger)",
                padding: "8px 14px",
                borderRadius: "var(--radius-sm)",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Revoke token
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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
          color: "var(--text-primary)",
          fontFamily: mono ? "var(--font-mono)" : "inherit",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}
