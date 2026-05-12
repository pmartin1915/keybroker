import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { BrokerClient } from "../api/client.js";

// Phase 4.1 c4 — Management token prompt modal.
//
// Surfaced when a Tokens-screen action (Issue / Revoke) needs auth and
// no valid token is cached. Probes the pasted token against the broker
// (POST /admin/tokens/rotate with empty filters — 400 means auth passed,
// 401 means it didn't) before committing it to the client, so a typo'd
// paste fails fast instead of failing during the real write.
//
// Lifecycle (c1 invariant 4): the token never leaves this component
// except via `client.setMgmtToken`, which stores it in process memory
// only. When the TUI exits, the JWT is gone. Cancel / Esc drops the
// pending action without committing anything.
//
// Focus model (c1 invariant 5): the modal owns input via the focus
// capture flag the parent sets when it pushes us. Esc cancels; Enter
// submits via TextInput's onSubmit.

export interface MgmtTokenPromptProps {
  client: BrokerClient;
  initialReason?: string;
  onConfirmed: () => void;
  onCancel: () => void;
}

export function MgmtTokenPrompt({
  client,
  initialReason,
  onConfirmed,
  onCancel,
}: MgmtTokenPromptProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(initialReason ?? null);
  const [probing, setProbing] = useState(false);

  // Esc cancels. Enter is handled by TextInput's onSubmit so users can
  // paste a multi-line JWT and Enter triggers probe regardless of which
  // wrapped line they're on.
  useInput(
    (_input, key) => {
      if (key.escape && !probing) onCancel();
    },
    { isActive: true },
  );

  const submit = async (raw: string) => {
    const tok = raw.trim();
    if (!tok.startsWith("brkm_")) {
      setError(
        "tokens issued via `keybroker token mgmt --issue` start with brkm_",
      );
      return;
    }
    setProbing(true);
    setError(null);
    const res = await client.probeMgmtToken(tok);
    setProbing(false);
    if (!res.ok) {
      setError(`token rejected: ${res.reason}`);
      return;
    }
    client.setMgmtToken(tok);
    setValue("");
    onConfirmed();
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Text bold color="yellow">Management token required</Text>
      <Box marginTop={1}>
        <Text color="gray">
          Issue / revoke / rotate need a `brkm_…` token. It is cached for
          this TUI process only — closing the TUI drops it.
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Mint one with:{"  "}</Text>
        <Text color="cyan">keybroker token mgmt --issue --label tui</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan">paste: </Text>
        {probing ? (
          <Text color="gray">validating…</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(v: string) => void submit(v)}
            placeholder="brkm_…"
            showCursor
          />
        )}
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color="gray">Enter to probe & save · Esc to cancel</Text>
      </Box>
    </Box>
  );
}
