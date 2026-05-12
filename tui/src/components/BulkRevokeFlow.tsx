import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  MgmtAuthError,
  type BrokerClient,
  type TokenRow,
} from "../api/client.js";

// Phase 4.1 c5b — Bulk revoke flow.
//
// Ports web/'s BulkRevokeModal to Ink. Three phases: confirm → running →
// done. The DELETE loop is strictly sequential (c1 invariant 9 / c4
// invariant 10): audit ordering matters and parallel revokes against
// the same store would race on the busy-timeout.
//
// Ceremony (web 4d invariant 3): three explicit operator steps:
//   1. Hit X on the Tokens screen (selection must be non-empty).
//   2. In the confirm phase, hit `x` to arm.
//   3. Hit `y` to fire.
//
// Mid-batch auth (web 4d invariant 4): if any DELETE returns 401, the
// loop calls `onExecuted()` (so the parent refreshes — already-revoked
// rows stay revoked) and then `onNeedsAuth(remainingIds, outcomesSoFar)`.
// The parent pushes mgmtPrompt with the pending action carrying the tail
// of un-attempted ids and the accumulated outcomes so resume re-mounts
// at the running phase with the same shape.

export type BulkOutcome =
  | { kind: "pending" }
  | { kind: "revoked"; alreadyRevoked: boolean }
  | { kind: "failed"; message: string };

export type BulkPhase =
  | { kind: "confirm"; tokens: TokenRow[] }
  | { kind: "running"; tokens: TokenRow[]; outcomes: Record<string, BulkOutcome> }
  | { kind: "done"; outcomes: Record<string, BulkOutcome> };

export interface BulkRevokeFlowProps {
  client: BrokerClient;
  phase: BulkPhase;
  onTransition: (next: BulkPhase) => void;
  onClose: () => void;
  onNeedsAuth: (
    remainingIds: string[],
    outcomesSoFar: Record<string, BulkOutcome>,
  ) => void;
  onExecuted: () => void;
}

export function BulkRevokeFlow(props: BulkRevokeFlowProps) {
  const { phase } = props;
  if (phase.kind === "confirm") {
    const tokens = phase.tokens;
    return (
      <BulkConfirmPhase
        tokens={tokens}
        onClose={props.onClose}
        onStart={() => {
          const outcomes: Record<string, BulkOutcome> = {};
          for (const t of tokens) outcomes[t.id] = { kind: "pending" };
          props.onTransition({ kind: "running", tokens, outcomes });
        }}
      />
    );
  }
  if (phase.kind === "running") {
    return (
      <BulkRunningPhase
        client={props.client}
        tokens={phase.tokens}
        outcomes={phase.outcomes}
        onTransition={props.onTransition}
        onNeedsAuth={props.onNeedsAuth}
        onExecuted={props.onExecuted}
      />
    );
  }
  return <BulkDonePhase outcomes={phase.outcomes} onClose={props.onClose} />;
}

// ── Phase 1: confirm ─────────────────────────────────────────────────

function BulkConfirmPhase({
  tokens,
  onClose,
  onStart,
}: {
  tokens: TokenRow[];
  onClose: () => void;
  onStart: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useInput(
    (input, key) => {
      if (confirming) {
        if (input === "y") {
          if (tokens.length > 0) onStart();
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
      if (input === "x") {
        if (tokens.length > 0) setConfirming(true);
        return;
      }
    },
    { isActive: true },
  );

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
          Revoke {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
        </Text>
        <Text color="gray">DELETE /admin/tokens/:id × N</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          Each row is a separate DELETE call. This is immediate and cannot be undone.
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tokens.map((t) => (
          <BulkConfirmRow key={t.id} token={t} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          {confirming ? (
            <>
              <Text color="red" bold>
                Revoke {tokens.length}{" "}
                {tokens.length === 1 ? "token" : "tokens"}?
              </Text>{" "}
              <Text color="red" bold>
                y
              </Text>{" "}
              confirm · <Text color="white" bold>n</Text> /{" "}
              <Text color="white" bold>Esc</Text> cancel
            </>
          ) : (
            <>
              <Text color="red">x</Text> arm revoke · <Text color="white">Esc</Text>{" "}
              cancel
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

function BulkConfirmRow({ token }: { token: TokenRow }) {
  return (
    <Box>
      <Box width={2}>
        <Text color="red">•</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="white">{token.label}</Text>
        <Text color="gray">  </Text>
        <Text color="gray">
          {token.id} · {token.provider}
          {token.tagTeam ? ` · team:${token.tagTeam}` : ""}
          {token.tagProject ? ` · proj:${token.tagProject}` : ""}
          {token.tagEnv ? ` · env:${token.tagEnv}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

// ── Phase 2: running ─────────────────────────────────────────────────

function BulkRunningPhase({
  client,
  tokens,
  outcomes,
  onTransition,
  onNeedsAuth,
  onExecuted,
}: {
  client: BrokerClient;
  tokens: TokenRow[];
  outcomes: Record<string, BulkOutcome>;
  onTransition: (next: BulkPhase) => void;
  onNeedsAuth: (
    remainingIds: string[],
    outcomesSoFar: Record<string, BulkOutcome>,
  ) => void;
  onExecuted: () => void;
}) {
  // The DELETE loop runs once per mount. React strict-mode double-mount
  // would otherwise fire two parallel loops against the same fleet — the
  // ref guard prevents it. We only start the loop for rows that are
  // still `pending` in the incoming outcomes map; this is the resume-
  // after-auth contract (outcomesSoFar carries the already-revoked rows
  // back into the phase so we don't re-attempt them).
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    let mutated = false;
    let working = outcomes;

    const run = async () => {
      for (const t of tokens) {
        if (cancelled) return;
        if (working[t.id]?.kind !== "pending") continue;
        try {
          const result = await client.revokeProxyToken(t.id);
          working = {
            ...working,
            [t.id]: {
              kind: "revoked",
              alreadyRevoked: result.alreadyRevoked === true,
            },
          };
          mutated = true;
          if (!cancelled) {
            onTransition({ kind: "running", tokens, outcomes: working });
          }
        } catch (e) {
          if (e instanceof MgmtAuthError) {
            if (mutated) onExecuted();
            const remaining = tokens
              .filter((row) => working[row.id]?.kind === "pending")
              .map((row) => row.id);
            onNeedsAuth(remaining, working);
            return;
          }
          working = {
            ...working,
            [t.id]: {
              kind: "failed",
              message: e instanceof Error ? e.message : String(e),
            },
          };
          if (!cancelled) {
            onTransition({ kind: "running", tokens, outcomes: working });
          }
        }
      }
      if (cancelled) return;
      if (mutated) onExecuted();
      onTransition({ kind: "done", outcomes: working });
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No interactive input during the loop — c4 invariant 10's audit
  // ordering depends on the loop completing without screen switches.
  useInput(() => {}, { isActive: true });

  const totals = summarize(outcomes);
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
          Revoking {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
        </Text>
        <Text color="gray">sequential DELETEs · do not switch screens</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {tokens.map((t) => (
          <BulkOutcomeRow
            key={t.id}
            token={t}
            outcome={outcomes[t.id] ?? { kind: "pending" }}
          />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          revoked {totals.revoked} · already-revoked {totals.alreadyRevoked} · failed{" "}
          {totals.failed} · pending {totals.pending}
        </Text>
      </Box>
    </Box>
  );
}

// ── Phase 3: done ────────────────────────────────────────────────────

function BulkDonePhase({
  outcomes,
  onClose,
}: {
  outcomes: Record<string, BulkOutcome>;
  onClose: () => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || key.escape || input === "q" || input === "d") {
        onClose();
      }
    },
    { isActive: true },
  );
  const totals = summarize(outcomes);
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
          Revoke complete
        </Text>
        <Text color="gray">DELETE × N done</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          revoked <Text bold color="white">{totals.revoked}</Text> · already-revoked{" "}
          <Text bold color="white">{totals.alreadyRevoked}</Text> · failed{" "}
          <Text bold color={totals.failed > 0 ? "red" : "white"}>{totals.failed}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {Object.entries(outcomes).map(([id, outcome]) => (
          <BulkOutcomeFinalRow key={id} id={id} outcome={outcome} />
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Press Enter / Esc / d / q to dismiss.</Text>
      </Box>
    </Box>
  );
}

function BulkOutcomeRow({
  token,
  outcome,
}: {
  token: TokenRow;
  outcome: BulkOutcome;
}) {
  return (
    <Box>
      <Box width={2}>
        <Text color="gray">•</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="white">{truncate(token.label, 22)}</Text>
        <Text color="gray">{truncate(token.id, 14)}</Text>
      </Box>
      <OutcomeBadge outcome={outcome} />
    </Box>
  );
}

function BulkOutcomeFinalRow({
  id,
  outcome,
}: {
  id: string;
  outcome: BulkOutcome;
}) {
  return (
    <Box>
      <Box width={2}>
        <Text color="gray">•</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color="gray">{truncate(id, 24)}</Text>
      </Box>
      <OutcomeBadge outcome={outcome} />
    </Box>
  );
}

function OutcomeBadge({ outcome }: { outcome: BulkOutcome }) {
  if (outcome.kind === "pending") {
    return <Text color="gray">queued</Text>;
  }
  if (outcome.kind === "revoked") {
    return (
      <Text
        color={outcome.alreadyRevoked ? "gray" : "red"}
        bold={!outcome.alreadyRevoked}
      >
        {outcome.alreadyRevoked ? "ALREADY REVOKED" : "REVOKED"}
      </Text>
    );
  }
  return (
    <Text color="red" bold>
      FAILED ({outcome.message})
    </Text>
  );
}

function summarize(outcomes: Record<string, BulkOutcome>) {
  let revoked = 0;
  let alreadyRevoked = 0;
  let failed = 0;
  let pending = 0;
  for (const o of Object.values(outcomes)) {
    if (o.kind === "revoked") {
      if (o.alreadyRevoked) alreadyRevoked++;
      else revoked++;
    } else if (o.kind === "failed") {
      failed++;
    } else {
      pending++;
    }
  }
  return { revoked, alreadyRevoked, failed, pending };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.padEnd(n);
  return s.slice(0, n - 1) + "…";
}
