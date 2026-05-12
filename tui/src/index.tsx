#!/usr/bin/env node
// Phase 4.1 c1 — TUI entry point.
//
// Wired from `src/cli.ts`'s `tui` subcommand. Expects a broker running on
// loopback (default http://127.0.0.1:7843, override with --broker-url or
// KEYBROKER_URL). Invariant 3: the TUI does NOT spawn a broker.

import React from "react";
import { render } from "ink";
import { BrokerClient } from "./api/client.js";
import { App } from "./App.js";

interface RunOpts {
  brokerUrl: string;
}

function parseArgv(argv: readonly string[]): RunOpts {
  const fromEnv = process.env.KEYBROKER_URL;
  let brokerUrl = fromEnv && fromEnv.length > 0 ? fromEnv : "http://127.0.0.1:7843";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--broker-url") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--broker-url requires a value");
      }
      brokerUrl = next;
      i++;
    } else if (a !== undefined && a.startsWith("--broker-url=")) {
      brokerUrl = a.slice("--broker-url=".length);
    }
  }
  return { brokerUrl };
}

async function probeBroker(client: BrokerClient): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const health = await client.fetchHealth();
    if (!health.ok) {
      return { ok: false, reason: "broker reported ok:false" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let opts: RunOpts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write(`keybroker tui: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const client = new BrokerClient(opts.brokerUrl);

  // Phase 4.1 invariant 3: fail fast and loud if the broker isn't there.
  // Operators in a tmux pane should know immediately, not see a flashing
  // "loading…" forever.
  const probe = await probeBroker(client);
  if (!probe.ok) {
    process.stderr.write(
      `keybroker tui: cannot reach broker at ${client.baseUrl}\n` +
        `  reason: ${probe.reason}\n` +
        `  hint:   start it with \`keybroker serve\`, or pass --broker-url\n`,
    );
    return 1;
  }

  const { waitUntilExit } = render(<App client={client} />);
  await waitUntilExit();
  return 0;
}
