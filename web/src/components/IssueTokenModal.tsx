import { useState } from "react";
import {
  issueProxyToken,
  MgmtAuthError,
  type IssueTokenResponse,
} from "../api/client.js";

/**
 * Phase 4.0 c4: form modal for POST /admin/tokens. Mirrors the CLI's
 * `token issue` flag surface. On success the freshly-minted JWT is
 * shown in a one-time copy-paste reveal — refreshing the modal or
 * closing it loses the value, so the operator must copy it before
 * dismissing. This is the only place in the UI that ever shows token
 * bytes; nothing is logged, nothing is persisted.
 */
export function IssueTokenModal({
  defaultProvider,
  onClose,
  onIssued,
  onNeedsAuth,
}: {
  defaultProvider?: string;
  onClose: () => void;
  onIssued: (response: IssueTokenResponse) => void;
  onNeedsAuth: (reason: string) => void;
}) {
  const [provider, setProvider] = useState(defaultProvider ?? "");
  const [label, setLabel] = useState("");
  const [ttlHours, setTtlHours] = useState("24");
  const [capUsd, setCapUsd] = useState("");
  const [team, setTeam] = useState("");
  const [project, setProject] = useState("");
  const [env, setEnv] = useState("");
  const [models, setModels] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssueTokenResponse | null>(null);

  const submit = async () => {
    setError(null);
    if (provider.trim().length === 0) {
      setError("provider is required");
      return;
    }
    const ttlNum = Number(ttlHours);
    if (!Number.isFinite(ttlNum) || ttlNum < 0) {
      setError("ttl must be a non-negative number of hours");
      return;
    }
    let capNum: number | undefined;
    if (capUsd.trim().length > 0) {
      capNum = Number(capUsd);
      if (!Number.isFinite(capNum) || capNum < 0) {
        setError("cap must be a non-negative number");
        return;
      }
    }
    const tags: { team?: string; project?: string; env?: string } = {};
    if (team.trim()) tags.team = team.trim();
    if (project.trim()) tags.project = project.trim();
    if (env.trim()) tags.env = env.trim();
    const body: Parameters<typeof issueProxyToken>[0] = {
      provider: provider.trim(),
      ttlSeconds: Math.floor(ttlNum * 3600),
    };
    if (label.trim()) body.label = label.trim();
    if (capNum !== undefined && capNum > 0) body.capUsd = capNum;
    if (Object.keys(tags).length > 0) body.tags = tags;
    if (models.trim()) {
      body.models = models
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    setSubmitting(true);
    try {
      const result = await issueProxyToken(body);
      setIssued(result);
      onIssued(result);
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        onNeedsAuth(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={overlayStyle}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          ...modalStyle,
          width: 560,
        }}
        className="anim-fade"
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
              {issued ? "Token minted" : "Issue token"}
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {issued
                ? "Copy the JWT now — refreshing this view loses it."
                : "Mints a proxy token via POST /admin/tokens."}
            </span>
          </div>
          <button
            onClick={onClose}
            style={closeButtonStyle}
            aria-label="close"
          >
            ×
          </button>
        </header>

        {issued ? (
          <IssuedReveal response={issued} onClose={onClose} />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Provider *">
                <input
                  type="text"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  placeholder="echo / openai / anthropic"
                  style={inputStyle}
                  autoFocus
                />
              </Field>
              <Field label="Label">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="unlabeled"
                  style={inputStyle}
                />
              </Field>
              <Field label="TTL (hours)">
                <input
                  type="text"
                  value={ttlHours}
                  onChange={(e) => setTtlHours(e.target.value)}
                  placeholder="24 — 0 for no expiry"
                  style={inputStyle}
                />
              </Field>
              <Field label="Cap (USD)">
                <input
                  type="text"
                  value={capUsd}
                  onChange={(e) => setCapUsd(e.target.value)}
                  placeholder="optional, e.g. 5.00"
                  style={inputStyle}
                />
              </Field>
              <Field label="Team">
                <input
                  type="text"
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                  placeholder="platform"
                  style={inputStyle}
                />
              </Field>
              <Field label="Project">
                <input
                  type="text"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  placeholder="broker"
                  style={inputStyle}
                />
              </Field>
              <Field label="Env">
                <input
                  type="text"
                  value={env}
                  onChange={(e) => setEnv(e.target.value)}
                  placeholder="dev / staging / prod"
                  style={inputStyle}
                />
              </Field>
              <Field label="Models (comma-sep)">
                <input
                  type="text"
                  value={models}
                  onChange={(e) => setModels(e.target.value)}
                  placeholder="gpt-4o-mini*"
                  style={inputStyle}
                />
              </Field>
            </div>
            {error ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--danger)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {error}
              </div>
            ) : null}
            <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} disabled={submitting} style={secondaryButton}>
                Cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={submitting}
                style={primaryButton}
              >
                {submitting ? "Issuing…" : "Issue token"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function IssuedReveal({
  response,
  onClose,
}: {
  response: IssueTokenResponse;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(response.jwt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked; fall back to user-select.
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: 12,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-primary)",
          wordBreak: "break-all",
          userSelect: "all",
          maxHeight: 140,
          overflow: "auto",
        }}
      >
        {response.jwt}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
        Token id <code style={{ fontFamily: "var(--font-mono)" }}>{response.tokenId}</code>{" "}
        · provider <code style={{ fontFamily: "var(--font-mono)" }}>{response.record.provider}</code>
        {response.record.capUsd !== undefined ? (
          <>
            {" "}· cap{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>
              ${response.record.capUsd.toFixed(2)}
            </code>
          </>
        ) : null}
      </div>
      <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={() => void copy()} style={secondaryButton}>
          {copied ? "Copied ✓" : "Copy JWT"}
        </button>
        <button onClick={onClose} style={primaryButton}>
          Done
        </button>
      </footer>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
      }}
    >
      {label}
      {children}
    </label>
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

const inputStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-sm)",
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  textTransform: "none",
  letterSpacing: 0,
  fontWeight: 400,
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
