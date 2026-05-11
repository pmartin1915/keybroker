import { useState } from "react";
import { probeMgmtToken, setMgmtToken } from "../api/client.js";

/**
 * Phase 4.0 c4: management-token paste modal. Surfaced when a Tokens-
 * screen action (Issue / Revoke / Rotate) needs auth and no valid
 * token is cached. The modal validates the pasted token against the
 * broker (POST /admin/tokens/rotate with empty filters — 400 means
 * auth passed, 401 means it didn't) before storing it, so a typo'd
 * paste fails fast instead of failing during the real write.
 *
 * The token never leaves this component except via the `setMgmtToken`
 * sessionStorage write. The `onConfirmed` callback fires after a
 * successful probe — the caller resumes whatever admin action
 * triggered the prompt.
 */
export function MgmtTokenModal({
  initialReason,
  onConfirmed,
  onCancel,
}: {
  initialReason?: string;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(initialReason ?? null);
  const [probing, setProbing] = useState(false);

  const submit = async () => {
    const tok = value.trim();
    if (!tok.startsWith("brkm_")) {
      setError(
        "tokens issued via `keybroker token mgmt --issue` start with brkm_",
      );
      return;
    }
    setProbing(true);
    setError(null);
    const res = await probeMgmtToken(tok);
    setProbing(false);
    if (!res.ok) {
      setError(`token rejected: ${res.reason}`);
      return;
    }
    setMgmtToken(tok);
    setValue("");
    onConfirmed();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "92vw",
          background: "var(--bg-paper)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius)",
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxShadow: "var(--shadow)",
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
              Management token
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Required for issue / revoke / rotate. Cached in this tab only.
            </span>
          </div>
          <button
            onClick={onCancel}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 20,
              cursor: "pointer",
              padding: 4,
              lineHeight: 1,
            }}
            aria-label="cancel"
          >
            ×
          </button>
        </header>
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-sm)",
            padding: 12,
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>$ </span>
          keybroker token mgmt --issue --label dashboard
        </div>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          Paste token (brkm_…)
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="brkm_…"
            rows={3}
            spellCheck={false}
            autoFocus
            style={{
              background: "var(--bg-surface)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              padding: 12,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
              resize: "vertical",
              minHeight: 64,
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 400,
            }}
          />
        </label>
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
          <button
            onClick={onCancel}
            disabled={probing}
            style={secondaryButton}
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={probing || value.trim().length === 0}
            style={primaryButton}
          >
            {probing ? "Validating…" : "Save & continue"}
          </button>
        </footer>
      </div>
    </div>
  );
}

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
