import { useState } from "react";
import {
  rotatePreview,
  rotateDryRun,
  rotateExecute,
  MgmtAuthError,
  type RotateFilters,
  type RotatePreview,
  type RotateDryRun,
  type RotateResult,
} from "../api/client.js";

/**
 * Phase 4.0 c4c: rotate-all UI. Three-step blast-radius flow:
 *
 *   1. filter — operator fills team / project / env / machine / provider
 *      and hits "Preview impact". At least one filter is required
 *      (mirrors the server's `no_filters` 400 — see Phase 3.8 decision 1).
 *   2. preview — counts only, no writes. Operator sees byMachine /
 *      byTeam / byProject / byEnv breakdowns and confirms.
 *   3. dryRun — per-token reissue plan plus the expired-skip list and
 *      `noModelsClaim` warnings for pre-3.8 records. Operator confirms.
 *   4. result — grid of newly-minted JWTs with per-row Copy buttons
 *      and a Copy-all-as-JSON fallback. This is the only place the new
 *      bytes are ever shown; closing the modal loses them.
 *
 * Each transition is a separate button — no auto-advance, no
 * "skip confirm" affordance (Phase 4.0 c4 stop-trigger).
 *
 * Auth failures at any step bubble up via `onNeedsAuth`; the caller
 * resumes the rotate flow from step 1 once a token is re-cached.
 */
export function RotateTokensModal({
  onClose,
  onExecuted,
  onNeedsAuth,
}: {
  onClose: () => void;
  onExecuted: (result: RotateResult) => void;
  onNeedsAuth: (reason: string) => void;
}) {
  const [step, setStep] = useState<"filter" | "preview" | "dryRun" | "result">(
    "filter",
  );
  const [filters, setFilters] = useState<RotateFilters>({});
  const [previewData, setPreviewData] = useState<RotatePreview | null>(null);
  const [dryRunData, setDryRunData] = useState<RotateDryRun | null>(null);
  const [resultData, setResultData] = useState<RotateResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runStep = async <T,>(
    fn: () => Promise<T>,
    onSuccess: (value: T) => void,
  ) => {
    setSubmitting(true);
    setError(null);
    try {
      const value = await fn();
      onSuccess(value);
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

  const submitFilters = (next: RotateFilters) => {
    if (Object.keys(next).length === 0) {
      setError(
        "at least one filter (team / project / env / machine / provider) is required",
      );
      return;
    }
    setFilters(next);
    void runStep(
      () => rotatePreview(next),
      (data) => {
        setPreviewData(data);
        setStep("preview");
      },
    );
  };

  const proceedToDryRun = () => {
    void runStep(
      () => rotateDryRun(filters),
      (data) => {
        setDryRunData(data);
        setStep("dryRun");
      },
    );
  };

  const proceedToExecute = () => {
    void runStep(
      () => rotateExecute(filters),
      (data) => {
        setResultData(data);
        setStep("result");
        onExecuted(data);
      },
    );
  };

  const back = () => {
    setError(null);
    if (step === "preview") setStep("filter");
    else if (step === "dryRun") setStep("preview");
  };

  return (
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...modalStyle, width: 680 }}
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
              {step === "filter"
                ? "Rotate matched tokens"
                : step === "preview"
                  ? "Blast radius"
                  : step === "dryRun"
                    ? "Confirm reissue plan"
                    : "Rotation complete"}
            </h2>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {step === "filter"
                ? "At least one filter is required — full-fleet rotation is intentionally not supported."
                : step === "preview"
                  ? "Counts only — nothing has been revoked yet."
                  : step === "dryRun"
                    ? "Each match will be revoked and reissued with identical claims and the remaining TTL."
                    : "Copy each new JWT now — closing this view loses them."}
            </span>
          </div>
          <StepBadge step={step} />
          <button onClick={onClose} style={closeButtonStyle} aria-label="close">
            ×
          </button>
        </header>

        {step === "filter" ? (
          <FilterForm
            initial={filters}
            submitting={submitting}
            onCancel={onClose}
            onSubmit={submitFilters}
          />
        ) : null}

        {step === "preview" && previewData ? (
          <PreviewPanel
            data={previewData}
            submitting={submitting}
            onBack={back}
            onContinue={proceedToDryRun}
          />
        ) : null}

        {step === "dryRun" && dryRunData ? (
          <DryRunPanel
            data={dryRunData}
            submitting={submitting}
            onBack={back}
            onExecute={proceedToExecute}
          />
        ) : null}

        {step === "result" && resultData ? (
          <ResultPanel data={resultData} onClose={onClose} />
        ) : null}

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
      </div>
    </div>
  );
}

function StepBadge({ step }: { step: "filter" | "preview" | "dryRun" | "result" }) {
  const idx = step === "filter" ? 1 : step === "preview" ? 2 : step === "dryRun" ? 3 : 4;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        padding: "4px 8px",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      step {idx} of 4
    </span>
  );
}

function FilterForm({
  initial,
  submitting,
  onCancel,
  onSubmit,
}: {
  initial: RotateFilters;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (filters: RotateFilters) => void;
}) {
  const [team, setTeam] = useState(initial.team ?? "");
  const [project, setProject] = useState(initial.project ?? "");
  const [env, setEnv] = useState(initial.env ?? "");
  const [machine, setMachine] = useState(initial.machine ?? "");
  const [provider, setProvider] = useState(initial.provider ?? "");

  const build = (): RotateFilters => {
    const f: RotateFilters = {};
    if (team.trim()) f.team = team.trim();
    if (project.trim()) f.project = project.trim();
    if (env.trim()) f.env = env.trim();
    if (machine.trim()) f.machine = machine.trim();
    if (provider.trim()) f.provider = provider.trim();
    return f;
  };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Team">
          <input
            type="text"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            placeholder="platform"
            style={inputStyle}
            autoFocus
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
        <Field label="Machine">
          <input
            type="text"
            value={machine}
            onChange={(e) => setMachine(e.target.value)}
            placeholder="hostname"
            style={inputStyle}
          />
        </Field>
        <Field label="Provider">
          <input
            type="text"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="echo / openai / anthropic"
            style={inputStyle}
          />
        </Field>
      </div>
      <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onCancel} disabled={submitting} style={secondaryButton}>
          Cancel
        </button>
        <button
          onClick={() => onSubmit(build())}
          disabled={submitting}
          style={primaryButton}
        >
          {submitting ? "Loading…" : "Preview impact →"}
        </button>
      </footer>
    </>
  );
}

function PreviewPanel({
  data,
  submitting,
  onBack,
  onContinue,
}: {
  data: RotatePreview;
  submitting: boolean;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { total, byMachine, byTeam, byProject, byEnv } = data.preview;
  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-sm)",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span
            style={{
              fontSize: 32,
              fontWeight: 700,
              color: total === 0 ? "var(--text-muted)" : "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              lineHeight: 1,
            }}
          >
            {total}
          </span>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            active tokens match these filters
          </span>
        </div>
        <FiltersEcho filters={data.filters} />
        {total > 0 ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Breakdown title="By machine" data={byMachine} />
            <Breakdown title="By team" data={byTeam} />
            <Breakdown title="By project" data={byProject} />
            <Breakdown title="By env" data={byEnv} />
          </div>
        ) : null}
      </div>
      <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onBack} disabled={submitting} style={secondaryButton}>
          ← Back
        </button>
        <button
          onClick={onContinue}
          disabled={submitting || total === 0}
          style={primaryButton}
        >
          {submitting ? "Loading…" : "Show reissue plan →"}
        </button>
      </footer>
    </>
  );
}

function DryRunPanel({
  data,
  submitting,
  onBack,
  onExecute,
}: {
  data: RotateDryRun;
  submitting: boolean;
  onBack: () => void;
  onExecute: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const lossyCount = data.plan.filter((p) => p.noModelsClaim).length;
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflow: "auto" }}>
        <FiltersEcho filters={data.filters} />
        {lossyCount > 0 ? (
          <div
            style={{
              background: "rgba(229, 162, 53, 0.08)",
              border: "1px solid var(--warning)",
              borderRadius: "var(--radius-sm)",
              padding: 10,
              fontSize: 12,
              color: "var(--warning)",
            }}
          >
            <strong>{lossyCount}</strong>{" "}
            {lossyCount === 1 ? "token is" : "tokens are"} pre-3.8 records and{" "}
            will lose any original model restriction on rotation. The new
            JWT will be issued without a <code>mdl</code> claim.
          </div>
        ) : null}
        {data.plan.length === 0 ? (
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              padding: 16,
              textAlign: "center",
            }}
          >
            No tokens are eligible for rotation (all matched tokens are expired).
          </div>
        ) : (
          <div
            style={{
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr 1fr 1fr 0.7fr",
                padding: "8px 12px",
                background: "var(--bg-paper)",
                borderBottom: "1px solid var(--border-subtle)",
                fontSize: 10,
                fontWeight: 700,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              <span>Label</span>
              <span>Old id</span>
              <span>New id</span>
              <span style={{ textAlign: "right" }}>Note</span>
            </div>
            {data.plan.map((p) => (
              <div
                key={p.oldId}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.4fr 1fr 1fr 0.7fr",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-primary)",
                  alignItems: "center",
                }}
              >
                <span className="truncate">{p.label}</span>
                <span className="truncate" style={{ color: "var(--text-secondary)" }}>
                  {p.oldId}
                </span>
                <span className="truncate" style={{ color: "var(--text-secondary)" }}>
                  {p.newId}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    color: p.noModelsClaim ? "var(--warning)" : "var(--text-muted)",
                    fontWeight: p.noModelsClaim ? 700 : 400,
                  }}
                >
                  {p.noModelsClaim ? "lossy" : "ok"}
                </span>
              </div>
            ))}
          </div>
        )}
        {data.expired.length > 0 ? (
          <div
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              paddingTop: 4,
            }}
          >
            Skipping {data.expired.length} expired:{" "}
            {data.expired.slice(0, 4).map((e) => e.label).join(", ")}
            {data.expired.length > 4 ? ` … and ${data.expired.length - 4} more` : ""}
          </div>
        ) : null}
      </div>
      <footer
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          alignItems: "center",
        }}
      >
        {confirming ? (
          <>
            <span
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginRight: "auto",
              }}
            >
              Revoke {data.plan.length}{" "}
              {data.plan.length === 1 ? "token" : "tokens"} and reissue? Immediate.
            </span>
            <button
              onClick={() => setConfirming(false)}
              disabled={submitting}
              style={secondaryButton}
            >
              Cancel
            </button>
            <button
              onClick={onExecute}
              disabled={submitting}
              style={dangerButton}
            >
              {submitting ? "Rotating…" : "Confirm execute"}
            </button>
          </>
        ) : (
          <>
            <button onClick={onBack} disabled={submitting} style={secondaryButton}>
              ← Back
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={submitting || data.plan.length === 0}
              style={dangerButton}
            >
              Execute rotation
            </button>
          </>
        )}
      </footer>
    </>
  );
}

function ResultPanel({
  data,
  onClose,
}: {
  data: RotateResult;
  onClose: () => void;
}) {
  const [copiedAll, setCopiedAll] = useState(false);
  const copyAll = async () => {
    const payload = JSON.stringify(
      data.reissued.map((r) => ({
        label: r.label,
        oldId: r.oldId,
        newId: r.newId,
        jwt: r.jwt,
        noModelsClaim: r.noModelsClaim,
      })),
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(payload);
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    } catch {
      // clipboard blocked — user can still copy individual rows below.
    }
  };
  return (
    <>
      <div
        style={{
          fontSize: 13,
          color: "var(--text-secondary)",
        }}
      >
        Revoked <strong style={{ color: "var(--text-primary)" }}>{data.revoked}</strong> and
        reissued <strong style={{ color: "var(--text-primary)" }}>{data.reissued.length}</strong>.
        {data.expired.length > 0 ? (
          <>
            {" "}Skipped <strong>{data.expired.length}</strong> expired.
          </>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: 380,
          overflow: "auto",
        }}
      >
        {data.reissued.map((r) => (
          <ReissuedRow key={r.newId} row={r} />
        ))}
      </div>
      <footer
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            marginRight: "auto",
          }}
        >
          Closing this view permanently loses the new JWT bytes.
        </span>
        <button onClick={() => void copyAll()} style={secondaryButton}>
          {copiedAll ? "Copied JSON ✓" : "Copy all (JSON)"}
        </button>
        <button onClick={onClose} style={primaryButton}>
          Done
        </button>
      </footer>
    </>
  );
}

function ReissuedRow({
  row,
}: {
  row: RotateResult["reissued"][number];
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.jwt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore — text is user-selectable below */
    }
  };
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
        }}
      >
        <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{row.label}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
          {row.oldId} → {row.newId}
        </span>
        {row.noModelsClaim ? (
          <span
            style={{
              color: "var(--warning)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            lossy
          </span>
        ) : null}
        <button onClick={() => void copy()} style={miniButton}>
          {copied ? "✓" : "Copy"}
        </button>
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--text-secondary)",
          wordBreak: "break-all",
          userSelect: "all",
          maxHeight: 80,
          overflow: "auto",
        }}
      >
        {row.jwt}
      </div>
    </div>
  );
}

function FiltersEcho({ filters }: { filters: RotateFilters }) {
  const entries = Object.entries(filters);
  if (entries.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
      }}
    >
      {entries.map(([k, v]) => (
        <span
          key={k}
          style={{
            background: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 4,
            padding: "2px 6px",
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>{k}=</span>
          <span style={{ color: "var(--text-primary)" }}>{v}</span>
        </span>
      ))}
    </div>
  );
}

function Breakdown({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
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
        {title}
      </span>
      {entries.length === 0 ? (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
      ) : (
        entries.slice(0, 5).map(([k, v]) => (
          <div
            key={k}
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
            }}
          >
            <span className="truncate" style={{ color: "var(--text-secondary)" }}>
              {k}
            </span>
            <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>
              {v}
            </span>
          </div>
        ))
      )}
      {entries.length > 5 ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          … +{entries.length - 5} more
        </span>
      ) : null}
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

const dangerButton: React.CSSProperties = {
  background: "var(--danger)",
  color: "var(--bg-ink)",
  border: "none",
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const miniButton: React.CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-subtle)",
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};
