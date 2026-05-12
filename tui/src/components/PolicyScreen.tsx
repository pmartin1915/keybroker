import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { type BrokerClient, type PolicySnapshot } from "../api/client.js";

// Phase 4.1 c6 — Policy screen (read-only).
//
// Mirrors web/src/components/PolicyScreen.tsx: scanner, forbidden models,
// allowed providers, tag allow-list. Read-only in c6 — editing requires
// a Phase 4.2+ design conversation (apply/reload semantics, conflict
// detection, validation). The wedge story is "is the guardrail wired
// up the way I think it is?", which a read-only render answers fully.
//
// No auto-refresh (c1 invariant 6). `r` refreshes manually.

export function PolicyScreen({ client }: { client: BrokerClient }) {
  const [policy, setPolicy] = useState<PolicySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastRefresh, setLastRefresh] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await client.fetchPolicy();
        if (!cancelled) {
          setPolicy(data);
          setError(null);
          setLoading(false);
          setLastRefresh(Date.now());
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, refreshTick]);

  useInput((input) => {
    if (input === "r") setRefreshTick((n) => n + 1);
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Header loading={loading} lastRefresh={lastRefresh} />
      {error ? (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red">/policy failed: {error}</Text>
        </Box>
      ) : null}
      {!loading && policy ? (
        <>
          <ScannerCard scanner={policy.scanner} />
          <ListCard
            title="Forbidden models"
            subtitle="glob patterns checked against the request body's model field"
            items={policy.forbiddenModels}
            tone="red"
            emptyText="none — only per-token mdl claims apply"
          />
          <ListCard
            title="Allowed providers"
            subtitle="when set, every other provider is refused regardless of token claim"
            items={policy.allowedProviders}
            tone="green"
            emptyText="no restriction (token's prv claim governs)"
          />
          <TagAllowListCard rows={policy.tagAllowlist} />
        </>
      ) : loading ? (
        <Text color="gray">loading…</Text>
      ) : (
        <Text color="gray">no policy data</Text>
      )}
      <HotkeyHint />
    </Box>
  );
}

function Header({
  loading,
  lastRefresh,
}: {
  loading: boolean;
  lastRefresh: number;
}) {
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">Policy</Text>
        <Text color="gray">
          {loading ? "loading…" : "active fleet guardrails"} · read-only · press r to refresh
        </Text>
      </Box>
      <Text color="gray">updated {new Date(lastRefresh).toLocaleTimeString()}</Text>
    </Box>
  );
}

function ScannerCard({ scanner }: { scanner: PolicySnapshot["scanner"] }) {
  const detectors =
    scanner.detectors === undefined
      ? "all built-ins"
      : scanner.detectors.length === 0
        ? "(empty — nothing will scan)"
        : scanner.detectors.join(", ");
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={scanner.enabled ? "green" : "gray"}
      paddingX={1}
    >
      <Text bold color="white">Scanner</Text>
      <Text color="gray" dimColor>
        Inline secret detection on outbound prompts (Phase 3.6)
      </Text>
      <Box marginTop={1} flexDirection="column">
        <KV
          label="Master switch"
          value={scanner.enabled ? "enabled" : "disabled"}
          color={scanner.enabled ? "green" : "red"}
        />
        <KV label="Detectors" value={detectors} />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          When the scanner fires, the request is blocked (outcome egress_blocked) and never reaches upstream. The audit row carries the detector name as `reason`; the matched bytes are never logged.
        </Text>
      </Box>
    </Box>
  );
}

function ListCard({
  title,
  subtitle,
  items,
  tone,
  emptyText,
}: {
  title: string;
  subtitle: string;
  items: readonly string[];
  tone: "red" | "green";
  emptyText: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="white">{title}</Text>
      <Text color="gray" dimColor>{subtitle}</Text>
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 ? (
          <Text color="gray">{emptyText}</Text>
        ) : (
          items.map((p) => (
            <Text key={p} color={tone}>
              {"  • "}
              <Text color="white">{p}</Text>
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

function TagAllowListCard({
  rows,
}: {
  rows: PolicySnapshot["tagAllowlist"];
}) {
  const entries = (["team", "project", "env"] as const).map((k) => ({
    k,
    v: rows[k] ?? [],
  }));
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="white">Tag allow-list</Text>
      <Text color="gray" dimColor>
        Per-tag value restrictions checked at issue time
      </Text>
      <Box marginTop={1} flexDirection="column">
        {entries.map(({ k, v }) => (
          <Box key={k} flexDirection="row">
            <Box width={10}>
              <Text color="gray" bold>{k}</Text>
            </Box>
            {v.length === 0 ? (
              <Text color="gray">(any value)</Text>
            ) : (
              <Text color="white">{v.join(", ")}</Text>
            )}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Tags omitted from the allow-list accept any non-empty short string. An explicit empty array is treated as "key omitted" — see policy.ts for rationale.
        </Text>
      </Box>
    </Box>
  );
}

function KV({ label, value, color = "white" }: { label: string; value: string; color?: string }) {
  return (
    <Box flexDirection="row">
      <Box width={18}>
        <Text color="gray">{label}</Text>
      </Box>
      <Text color={color} bold={color !== "white"}>{value}</Text>
    </Box>
  );
}

function HotkeyHint() {
  return (
    <Box>
      <Text color="gray">
        <Text color="white">r</Text> refresh
      </Text>
    </Box>
  );
}
