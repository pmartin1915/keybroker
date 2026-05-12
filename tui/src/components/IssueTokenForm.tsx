import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  MgmtAuthError,
  type BrokerClient,
  type IssueTokenBody,
  type IssueTokenResponse,
} from "../api/client.js";

// Phase 4.1 c4 — Issue token form modal.
//
// Mirrors web/'s IssueTokenModal: same field surface as the CLI's
// `token issue` flags, same validation rules, same one-time JWT reveal
// on success.
//
// Focus / hotkeys (c1 invariant 5):
//   ↑ / ↓ / Tab            move between fields
//   Enter on any field     submit the form (TextInput's onSubmit)
//   Esc                    cancel
//
// We don't gate Tab through TextInput — ink-text-input lets characters
// other than Enter / arrows pass through to useInput, so the parent's
// hotkey handler still sees Tab and can advance focus.
//
// Auth recovery (c1 invariant 5 + c4 web parity): when the broker
// responds 401, the screen pushes a MgmtTokenPrompt on top. We surface
// that via `onNeedsAuth` — the form unmounts (form state is dropped, by
// design; the user re-opens issue after auth succeeds). On 2xx success
// the modal transitions to its IssuedReveal sub-state and shows the JWT
// exactly once.

const FIELDS = [
  "provider",
  "label",
  "ttlHours",
  "capUsd",
  "team",
  "project",
  "env",
  "models",
] as const;
type Field = (typeof FIELDS)[number];

const FIELD_LABELS: Record<Field, string> = {
  provider: "Provider *",
  label: "Label",
  ttlHours: "TTL (hours)",
  capUsd: "Cap (USD)",
  team: "Team",
  project: "Project",
  env: "Env",
  models: "Models (comma-sep)",
};

const FIELD_PLACEHOLDERS: Record<Field, string> = {
  provider: "echo / openai / anthropic",
  label: "unlabeled",
  ttlHours: "24 — 0 for no expiry",
  capUsd: "optional, e.g. 5.00",
  team: "platform",
  project: "broker",
  env: "dev / staging / prod",
  models: "gpt-4o-mini*",
};

interface FormState {
  provider: string;
  label: string;
  ttlHours: string;
  capUsd: string;
  team: string;
  project: string;
  env: string;
  models: string;
}

const INITIAL_FORM: FormState = {
  provider: "",
  label: "",
  ttlHours: "24",
  capUsd: "",
  team: "",
  project: "",
  env: "",
  models: "",
};

export interface IssueTokenFormProps {
  client: BrokerClient;
  defaultProvider?: string;
  onCancel: () => void;
  onIssued: (response: IssueTokenResponse) => void;
  onNeedsAuth: (reason: string) => void;
}

export function IssueTokenForm({
  client,
  defaultProvider,
  onCancel,
  onIssued,
  onNeedsAuth,
}: IssueTokenFormProps) {
  const [form, setForm] = useState<FormState>({
    ...INITIAL_FORM,
    provider: defaultProvider ?? "",
  });
  const [focusIdx, setFocusIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setField = (k: Field) => (v: string) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    setError(null);
    if (form.provider.trim().length === 0) {
      setError("provider is required");
      return;
    }
    const ttlNum = Number(form.ttlHours);
    if (!Number.isFinite(ttlNum) || ttlNum < 0) {
      setError("ttl must be a non-negative number of hours");
      return;
    }
    let capNum: number | undefined;
    if (form.capUsd.trim().length > 0) {
      capNum = Number(form.capUsd);
      if (!Number.isFinite(capNum) || capNum < 0) {
        setError("cap must be a non-negative number");
        return;
      }
    }
    const body: IssueTokenBody = {
      provider: form.provider.trim(),
      ttlSeconds: Math.floor(ttlNum * 3600),
    };
    if (form.label.trim()) body.label = form.label.trim();
    if (capNum !== undefined && capNum > 0) body.capUsd = capNum;
    const tags: { team?: string; project?: string; env?: string } = {};
    if (form.team.trim()) tags.team = form.team.trim();
    if (form.project.trim()) tags.project = form.project.trim();
    if (form.env.trim()) tags.env = form.env.trim();
    if (Object.keys(tags).length > 0) body.tags = tags;
    if (form.models.trim()) {
      body.models = form.models
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    setSubmitting(true);
    try {
      const result = await client.issueProxyToken(body);
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

  // Esc / Tab / ↑↓ navigation. Letters / digits flow through to the
  // focused TextInput. Submit happens via TextInput's onSubmit (Enter).
  useInput(
    (input, key) => {
      if (submitting) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.tab && key.shift) {
        setFocusIdx((i) => (i + FIELDS.length - 1) % FIELDS.length);
        return;
      }
      if (key.tab || (key.downArrow && !key.shift)) {
        setFocusIdx((i) => (i + 1) % FIELDS.length);
        return;
      }
      if (key.upArrow) {
        setFocusIdx((i) => (i + FIELDS.length - 1) % FIELDS.length);
        return;
      }
      // Ctrl-S: explicit submit shortcut for users who don't want to
      // Enter from the focused field (e.g. they tabbed back to provider
      // and want to fire without round-tripping to models).
      if (key.ctrl && input === "s") {
        void submit();
        return;
      }
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
        <Text bold color="cyan">Issue token</Text>
        <Text color="gray">POST /admin/tokens</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Mirrors `keybroker token issue` flags. Provider is required;
          everything else is optional. JWT is shown ONCE on success.
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {FIELDS.map((f, i) => (
          <FormField
            key={f}
            label={FIELD_LABELS[f]}
            value={form[f]}
            onChange={setField(f)}
            onSubmit={() => void submit()}
            placeholder={FIELD_PLACEHOLDERS[f]}
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
          {submitting ? "Issuing…" : "Tab / ↑↓ navigate · Enter submits · Ctrl-S submits · Esc cancels"}
        </Text>
      </Box>
    </Box>
  );
}

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
      <Box width={20}>
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

// ── One-time JWT reveal ──────────────────────────────────────────────
//
// c1 invariant 7: full line, no truncation, "won't be shown again"
// wording, clear-screen on dismiss so the JWT bytes leave the terminal
// scroll-back. The clear-screen escape sequence (\x1b[3J) wipes the
// scroll buffer in addition to the visible viewport; combined with
// Ink's next render it ensures the next thing the operator sees is the
// post-issue Tokens screen, not the JWT.

export interface IssuedRevealProps {
  response: IssueTokenResponse;
  onDismiss: () => void;
}

export function IssuedReveal({ response, onDismiss }: IssuedRevealProps) {
  // Sole gate: any keystroke other than typing dismisses. Enter and Esc
  // are the obvious ones; we also accept `q` for quit-this-modal and
  // `d` for done, mirroring the web's "Done" button affordance.
  useInput(
    (input, key) => {
      if (key.return || key.escape || input === "q" || input === "d") {
        // Clear the visible screen + scroll buffer + put cursor home.
        // Done BEFORE we hand control back so the JWT-bearing frame is
        // not the last thing in the terminal history.
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        onDismiss();
      }
    },
    { isActive: true },
  );

  // noModelsClaim warning (c1 invariant 8 + Phase 3.8 decision 3):
  // mark issuance that will accept any model.
  const noModelsClaim =
    !response.record.models || response.record.models.length === 0;

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
        <Text bold color="green">Token minted</Text>
        <Text color="gray">{response.tokenId}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="yellow">
          Copy this JWT now — refreshing or dismissing this view loses it.
        </Text>
      </Box>
      <Box
        marginTop={1}
        borderStyle="single"
        borderColor="green"
        paddingX={1}
      >
        <Text color="white" wrap="wrap">{response.jwt}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          provider: <Text color="white">{response.record.provider}</Text>
          {response.record.label ? (
            <>
              {"  "}label: <Text color="white">{response.record.label}</Text>
            </>
          ) : null}
          {response.record.capUsd !== undefined ? (
            <>
              {"  "}cap: <Text color="white">${response.record.capUsd.toFixed(2)}</Text>
            </>
          ) : null}
        </Text>
        {noModelsClaim ? (
          <Text color="yellow">⚠ no models claim — will accept any model</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Select with your terminal to copy. Press Enter / Esc / d / q to dismiss.
        </Text>
      </Box>
    </Box>
  );
}
