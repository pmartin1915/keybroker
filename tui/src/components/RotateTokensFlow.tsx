import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  MgmtAuthError,
  type BrokerClient,
  type RotateFilters,
  type RotatePreview,
  type RotateDryRun,
  type RotateResult,
} from "../api/client.js";

// Phase 4.1 c5a — Rotate tokens 4-step ceremony.
//
// Ports web/'s RotateTokensModal.tsx to Ink. The ceremony IS the safety
// mechanism (web 4c invariant 1: no auto-advance, four explicit
// transitions). The TUI mirrors the same shape:
//
//   filter   → 5-field form. Empty submission gated client-side AND
//              server-side (broker returns 400 no_filters). Enter on
//              any field submits; Esc closes the entire flow.
//   preview  → blast-radius counts (no writes). Continue → dryRun.
//   dryRun   → per-row reissue plan with `lossy` flag for noModelsClaim
//              rows. Inline two-step `x` arms → `y` confirms, mirroring
//              c4's single-revoke pattern in TokenDetail.
//   reveal   → copy-friendly grid of new JWTs. Clears scroll buffer on
//              dismiss (c1 invariant 7 + c4 invariant 7).
//
// State ownership: the flow renders the active step; every transition
// calls back to TokensScreen via `onTransition`, which sets ModalState.
// The async fetches live inside each step; on MgmtAuthError, the step
// calls `onNeedsAuth` with a `pending: { kind: "rotate", filters,
// resumeAt }` shape — TokensScreen pushes mgmtPrompt with that pending.
// All three resumeAt cases collapse to filter-step re-entry (the
// fleet may have shifted between arm and re-auth — re-walk is correct).
//
// noModelsClaim wording matches the web UI exactly (c1 invariant 8 +
// Phase 3.8 decision 3); surfaced in dryRun banner, dryRun per-row
// "lossy" flag, and reveal per-row "lossy" badge — three times total
// (web 4c invariant 3).

export type RotateStep =
  | { kind: "filter"; initial: RotateFilters }
  | { kind: "preview"; filters: RotateFilters; data: RotatePreview }
  | { kind: "dryRun"; filters: RotateFilters; data: RotateDryRun }
  | { kind: "reveal"; result: RotateResult };

export type RotateResumeAt = "preview" | "dryRun" | "execute";

export interface RotateTokensFlowProps {
  client: BrokerClient;
  step: RotateStep;
  onTransition: (next: RotateStep) => void;
  onClose: () => void;
  onNeedsAuth: (filters: RotateFilters, resumeAt: RotateResumeAt) => void;
  onExecuted: () => void;
}

export function RotateTokensFlow(props: RotateTokensFlowProps) {
  if (props.step.kind === "filter") {
    return (
      <RotateFilterStep
        client={props.client}
        initial={props.step.initial}
        onTransition={props.onTransition}
        onClose={props.onClose}
        onNeedsAuth={props.onNeedsAuth}
      />
    );
  }
  if (props.step.kind === "preview") {
    return (
      <RotatePreviewStep
        client={props.client}
        filters={props.step.filters}
        data={props.step.data}
        onTransition={props.onTransition}
        onClose={props.onClose}
        onNeedsAuth={props.onNeedsAuth}
      />
    );
  }
  if (props.step.kind === "dryRun") {
    return (
      <RotateDryRunStep
        client={props.client}
        filters={props.step.filters}
        data={props.step.data}
        onTransition={props.onTransition}
        onClose={props.onClose}
        onNeedsAuth={props.onNeedsAuth}
        onExecuted={props.onExecuted}
      />
    );
  }
  return <RotateRevealStep result={props.step.result} onDismiss={props.onClose} />;
}

// ── Step 1: filter ───────────────────────────────────────────────────

const FILTER_FIELDS = ["team", "project", "env", "machine", "provider"] as const;
type FilterField = (typeof FILTER_FIELDS)[number];

const FILTER_LABELS: Record<FilterField, string> = {
  team: "Team",
  project: "Project",
  env: "Env",
  machine: "Machine",
  provider: "Provider",
};

const FILTER_PLACEHOLDERS: Record<FilterField, string> = {
  team: "platform",
  project: "broker",
  env: "dev / staging / prod",
  machine: "hostname",
  provider: "echo / openai / anthropic",
};

function RotateFilterStep({
  client,
  initial,
  onTransition,
  onClose,
  onNeedsAuth,
}: {
  client: BrokerClient;
  initial: RotateFilters;
  onTransition: (next: RotateStep) => void;
  onClose: () => void;
  onNeedsAuth: (filters: RotateFilters, resumeAt: RotateResumeAt) => void;
}) {
  const [form, setForm] = useState<Record<FilterField, string>>({
    team: initial.team ?? "",
    project: initial.project ?? "",
    env: initial.env ?? "",
    machine: initial.machine ?? "",
    provider: initial.provider ?? "",
  });
  const [focusIdx, setFocusIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (k: FilterField) => (v: string) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const buildFilters = (): RotateFilters => {
    const f: RotateFilters = {};
    if (form.team.trim()) f.team = form.team.trim();
    if (form.project.trim()) f.project = form.project.trim();
    if (form.env.trim()) f.env = form.env.trim();
    if (form.machine.trim()) f.machine = form.machine.trim();
    if (form.provider.trim()) f.provider = form.provider.trim();
    return f;
  };

  const submit = async () => {
    const filters = buildFilters();
    if (Object.keys(filters).length === 0) {
      // Client-side gate. Web 4c invariant 2: defence-in-depth.
      setError(
        "at least one filter (team / project / env / machine / provider) is required",
      );
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const data = await client.rotatePreview(filters);
      onTransition({ kind: "preview", filters, data });
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        onNeedsAuth(filters, "preview");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  useInput(
    (input, key) => {
      if (submitting) return;
      if (key.escape) {
        onClose();
        return;
      }
      if (key.tab && key.shift) {
        setFocusIdx((i) => (i + FILTER_FIELDS.length - 1) % FILTER_FIELDS.length);
        return;
      }
      if (key.tab || (key.downArrow && !key.shift)) {
        setFocusIdx((i) => (i + 1) % FILTER_FIELDS.length);
        return;
      }
      if (key.upArrow) {
        setFocusIdx((i) => (i + FILTER_FIELDS.length - 1) % FILTER_FIELDS.length);
      }
      // No Ctrl-S binding — c4 handoff risk #3 carry-forward (XOFF on
      // some terminals). The 5-field form is short; Enter-on-any-field
      // suffices.
    },
    { isActive: !submitting },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Rotate matched tokens
        </Text>
        <Text color="gray">step 1 of 4 · POST /admin/tokens/rotate</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          At least one filter is required — full-fleet rotation is intentionally not
          supported.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {FILTER_FIELDS.map((f, i) => (
          <FormField
            key={f}
            label={FILTER_LABELS[f]}
            value={form[f]}
            onChange={setField(f)}
            onSubmit={() => void submit()}
            placeholder={FILTER_PLACEHOLDERS[f]}
            focus={i === focusIdx && !submitting}
          />
        ))}
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">
          {submitting
            ? "Loading preview…"
            : "Tab / ↑↓ navigate · Enter submits · Esc cancels"}
        </Text>
      </Box>
    </Box>
  );
}

// ── Step 2: preview ──────────────────────────────────────────────────

function RotatePreviewStep({
  client,
  filters,
  data,
  onTransition,
  onClose,
  onNeedsAuth,
}: {
  client: BrokerClient;
  filters: RotateFilters;
  data: RotatePreview;
  onTransition: (next: RotateStep) => void;
  onClose: () => void;
  onNeedsAuth: (filters: RotateFilters, resumeAt: RotateResumeAt) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const proceed = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const next = await client.rotateDryRun(filters);
      onTransition({ kind: "dryRun", filters, data: next });
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        onNeedsAuth(filters, "dryRun");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  useInput(
    (input, key) => {
      if (submitting) return;
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "b" || (key.leftArrow && !key.shift)) {
        onTransition({ kind: "filter", initial: filters });
        return;
      }
      if (key.return || input === "c") {
        if (data.preview.total > 0) void proceed();
        return;
      }
    },
    { isActive: !submitting },
  );

  const { total, byMachine, byTeam, byProject, byEnv } = data.preview;
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Blast radius
        </Text>
        <Text color="gray">step 2 of 4 · counts only · nothing has been revoked yet</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold color={total === 0 ? "gray" : "yellow"}>
            {total}
          </Text>{" "}
          <Text color="gray">active tokens match these filters</Text>
        </Text>
      </Box>
      <FiltersEcho filters={data.filters} />
      {total > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <BreakdownRow title="by machine" data={byMachine} />
          <BreakdownRow title="by team" data={byTeam} />
          <BreakdownRow title="by project" data={byProject} />
          <BreakdownRow title="by env" data={byEnv} />
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">
          {submitting ? (
            "Loading plan…"
          ) : total === 0 ? (
            <>
              <Text color="white">b</Text> back · <Text color="white">Esc</Text> close
            </>
          ) : (
            <>
              <Text color="white">Enter</Text> / <Text color="white">c</Text> continue ·{" "}
              <Text color="white">b</Text> back · <Text color="white">Esc</Text> close
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

function BreakdownRow({
  title,
  data,
}: {
  title: string;
  data: Record<string, number>;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return (
      <Box>
        <Box width={14}>
          <Text color="gray">{title}</Text>
        </Box>
        <Text color="gray" dimColor>
          —
        </Text>
      </Box>
    );
  }
  const top = entries.slice(0, 5);
  const tail =
    entries.length > 5 ? ` … +${entries.length - 5} more` : "";
  return (
    <Box>
      <Box width={14}>
        <Text color="gray">{title}</Text>
      </Box>
      <Text color="white">
        {top.map(([k, v], i) => (
          <Text key={k}>
            {i > 0 ? "  " : ""}
            <Text color="cyan">{k}</Text>
            <Text color="gray">=</Text>
            <Text color="white">{v}</Text>
          </Text>
        ))}
        <Text color="gray" dimColor>
          {tail}
        </Text>
      </Text>
    </Box>
  );
}

// ── Step 3: dryRun ───────────────────────────────────────────────────

function RotateDryRunStep({
  client,
  filters,
  data,
  onTransition,
  onClose,
  onNeedsAuth,
  onExecuted,
}: {
  client: BrokerClient;
  filters: RotateFilters;
  data: RotateDryRun;
  onTransition: (next: RotateStep) => void;
  onClose: () => void;
  onNeedsAuth: (filters: RotateFilters, resumeAt: RotateResumeAt) => void;
  onExecuted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await client.rotateExecute(filters);
      onExecuted();
      onTransition({ kind: "reveal", result });
    } catch (e) {
      if (e instanceof MgmtAuthError) {
        onNeedsAuth(filters, "execute");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  useInput(
    (input, key) => {
      if (submitting) return;
      if (confirming) {
        if (input === "y") {
          if (data.plan.length > 0) void execute();
          return;
        }
        if (input === "n" || key.escape) {
          setConfirming(false);
          return;
        }
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "b" || (key.leftArrow && !key.shift)) {
        // Re-fire preview so we get a fresh blast-radius snapshot —
        // mirrors web's back button (which re-renders the cached preview,
        // but in the TUI re-fetching is honest given the staleness window).
        onTransition({ kind: "filter", initial: filters });
        return;
      }
      if (input === "x") {
        if (data.plan.length > 0) setConfirming(true);
        return;
      }
    },
    { isActive: !submitting },
  );

  const lossyCount = data.plan.filter((p) => p.noModelsClaim).length;

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={confirming ? "red" : "cyan"}
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={confirming ? "red" : "cyan"}>
          Confirm reissue plan
        </Text>
        <Text color="gray">step 3 of 4</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Each match will be revoked and reissued with identical claims and the
          remaining TTL.
        </Text>
      </Box>
      <FiltersEcho filters={data.filters} />

      {lossyCount > 0 ? (
        <Box
          marginTop={1}
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow">
            ⚠ <Text bold>{lossyCount}</Text>{" "}
            {lossyCount === 1 ? "token is a" : "tokens are"} pre-3.8{" "}
            {lossyCount === 1 ? "record" : "records"} and will lose any original
            model restriction on rotation. The new JWT will be issued without an
            mdl claim.
          </Text>
        </Box>
      ) : null}

      {data.plan.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">
            No tokens are eligible for rotation (all matched tokens are expired).
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DryRunHeaderRow />
          {data.plan.map((p) => (
            <DryRunPlanRow key={p.oldId} row={p} />
          ))}
        </Box>
      )}

      {data.expired.length > 0 ? (
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Skipping {data.expired.length} expired:{" "}
            {data.expired
              .slice(0, 4)
              .map((e) => e.label)
              .join(", ")}
            {data.expired.length > 4
              ? ` … and ${data.expired.length - 4} more`
              : ""}
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="gray">
          {submitting ? (
            "Rotating…"
          ) : confirming ? (
            <>
              <Text color="red" bold>
                Revoke {data.plan.length}{" "}
                {data.plan.length === 1 ? "token" : "tokens"} and reissue?
              </Text>{" "}
              <Text color="red" bold>
                y
              </Text>{" "}
              confirm · <Text color="white" bold>n</Text> /{" "}
              <Text color="white" bold>Esc</Text> cancel
            </>
          ) : data.plan.length === 0 ? (
            <>
              <Text color="white">b</Text> back · <Text color="white">Esc</Text> close
            </>
          ) : (
            <>
              <Text color="white">b</Text> back · <Text color="red">x</Text>{" "}
              arm execute · <Text color="white">Esc</Text> close
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

const DRYRUN_COL = { label: 24, oldId: 14, newId: 14, note: 6 };

function DryRunHeaderRow() {
  return (
    <Box>
      <Text color="gray" dimColor>
        {"LABEL".padEnd(DRYRUN_COL.label)}
        {"OLD ID".padEnd(DRYRUN_COL.oldId)}
        {"NEW ID".padEnd(DRYRUN_COL.newId)}
        {"NOTE".padEnd(DRYRUN_COL.note)}
      </Text>
    </Box>
  );
}

function DryRunPlanRow({
  row,
}: {
  row: { oldId: string; newId: string; label: string; noModelsClaim: boolean };
}) {
  return (
    <Box>
      <Text color="white">{truncate(row.label, DRYRUN_COL.label)}</Text>
      <Text color="gray">{truncate(row.oldId, DRYRUN_COL.oldId)}</Text>
      <Text color="gray">{truncate(row.newId, DRYRUN_COL.newId)}</Text>
      <Text color={row.noModelsClaim ? "yellow" : "gray"} bold={row.noModelsClaim}>
        {(row.noModelsClaim ? "lossy" : "ok").padEnd(DRYRUN_COL.note)}
      </Text>
    </Box>
  );
}

// ── Step 4: reveal ───────────────────────────────────────────────────

function RotateRevealStep({
  result,
  onDismiss,
}: {
  result: RotateResult;
  onDismiss: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || key.escape || input === "q" || input === "d") {
        // c1 invariant 7 / c4 invariant 7: wipe viewport + scroll buffer
        // BEFORE handing control back so the JWT-bearing frame is not
        // preserved in terminal scrollback.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        onDismiss();
      }
    },
    { isActive: true },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="green">
          Rotation complete
        </Text>
        <Text color="gray">step 4 of 4</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Revoked <Text bold color="white">{result.revoked}</Text> and reissued{" "}
          <Text bold color="white">{result.reissued.length}</Text>
          {result.expired.length > 0 ? (
            <>
              {" "}· skipped <Text bold color="white">{result.expired.length}</Text>{" "}
              expired
            </>
          ) : null}
          .
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="yellow">
          Copy each JWT now — dismissing this view loses them.
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {result.reissued.map((r) => (
          <ReissuedCard key={r.newId} row={r} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Select with your terminal to copy. Press Enter / Esc / d / q to dismiss.
        </Text>
      </Box>
    </Box>
  );
}

function ReissuedCard({
  row,
}: {
  row: {
    oldId: string;
    newId: string;
    label: string;
    jwt: string;
    noModelsClaim: boolean;
  };
}) {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="single"
      borderColor="green"
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="green">
          {row.label}
        </Text>
        <Text color="gray">
          {row.oldId} → {row.newId}
        </Text>
      </Box>
      {row.noModelsClaim ? (
        <Box>
          <Text color="yellow">⚠ no models claim — will accept any model</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="white" wrap="wrap">
          {row.jwt}
        </Text>
      </Box>
    </Box>
  );
}

// ── Shared sub-components ────────────────────────────────────────────

function FormField({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  focus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  focus: boolean;
}) {
  return (
    <Box>
      <Box width={14}>
        <Text color={focus ? "cyan" : "gray"} bold={focus}>
          {focus ? "▸ " : "  "}
          {label}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          focus={focus}
          showCursor={focus}
        />
      </Box>
    </Box>
  );
}

function FiltersEcho({ filters }: { filters: RotateFilters }) {
  const entries = Object.entries(filters).filter(([, v]) => v && v.length > 0);
  if (entries.length === 0) return null;
  return (
    <Box marginTop={1}>
      <Text color="gray">filters: </Text>
      <Text>
        {entries.map(([k, v], i) => (
          <Text key={k}>
            {i > 0 ? "  " : ""}
            <Text color="cyan">{k}</Text>
            <Text color="gray">=</Text>
            <Text color="white">{v}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}
