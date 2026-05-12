import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { SqliteStore } from "../src/store.js";
import { generateMasterKeyHex, generateJwtSecret } from "../src/crypto.js";
import type { BrokerConfig } from "../src/config.js";
import { BrokerClient } from "../tui/src/api/client.js";

// Phase 4.1 c1 — TUI client contract smoke.
//
// The TUI is a peer package (tui/) with its own React + Ink runtime; we
// don't render Ink in vitest (interactive stdin makes that fragile). The
// load-bearing contract is the HTTP API between the TUI and the broker:
// if BrokerClient's typed methods round-trip against a real broker, the
// rest of the TUI (which is layout over those return values) is on solid
// ground. Render-side regressions are the c2+ commits' problem.

let app: FastifyInstance;
let origin: string;
let dataDir: string;
let store: SqliteStore;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-tui-"));
  const masterKeyHex = generateMasterKeyHex();
  const jwtSecret = generateJwtSecret();
  const config: BrokerConfig = {
    dataDir,
    jsonStorePath: join(dataDir, "store.json"),
    sqliteStorePath: join(dataDir, "store.db"),
    logsPath: join(dataDir, "calls.log.jsonl"),
    configPath: join(dataDir, "config.json"),
    policyPath: join(dataDir, "policy.json"),
    port: 0,
    host: "127.0.0.1",
    masterKeyHex,
    jwtSecret,
    mgmtSecret: jwtSecret,
  };
  writeFileSync(
    config.configPath,
    JSON.stringify({ masterKeyHex, jwtSecret, port: 0, host: "127.0.0.1" }),
  );
  store = new SqliteStore(config.sqliteStorePath);
  app = await buildServer(config, { logger: false, store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
  store?.close?.();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("BrokerClient (TUI loopback client)", () => {
  it("normalizes trailing slashes in the base URL", () => {
    const c = new BrokerClient("http://127.0.0.1:7843///");
    expect(c.baseUrl).toBe("http://127.0.0.1:7843");
  });

  it("only accepts brkm_-prefixed mgmt tokens (defence-in-depth)", () => {
    const c = new BrokerClient("http://127.0.0.1:7843");
    expect(c.hasMgmtToken()).toBe(false);
    c.setMgmtToken("brk_not_a_mgmt_token");
    expect(c.hasMgmtToken()).toBe(false);
    c.setMgmtToken("brkm_some_valid_looking_jwt");
    expect(c.hasMgmtToken()).toBe(true);
    c.setMgmtToken(undefined);
    expect(c.hasMgmtToken()).toBe(false);
  });

  it("fetches /health with the expected shape", async () => {
    const client = new BrokerClient(origin);
    const h = await client.fetchHealth();
    expect(h.ok).toBe(true);
    expect(typeof h.keybroker_ok).toBe("boolean");
    expect(typeof h.version).toBe("string");
    expect(h.tokens.active).toBeGreaterThanOrEqual(0);
    expect(h.tokens.revoked).toBeGreaterThanOrEqual(0);
    expect(h.tokens.total).toBe(h.tokens.active + h.tokens.revoked);
    expect(typeof h.calls.last24h).toBe("number");
    expect(typeof h.calls.last24hSpendUsd).toBe("number");
    expect(typeof h.calls.last24hSpendUsdByMachine).toBe("object");
  });

  it("fetches /metrics/spend for each tag bucket", async () => {
    const client = new BrokerClient(origin);
    for (const bucket of ["team", "project", "env"] as const) {
      const rows = await client.fetchSpend(bucket, "24h", 10);
      expect(Array.isArray(rows)).toBe(true);
      // No tokens / no calls in a fresh store → empty array is fine.
      for (const r of rows) {
        expect(typeof r.key).toBe("string");
        expect(typeof r.usd).toBe("number");
        expect(typeof r.callCount).toBe("number");
      }
    }
  });

  it("fetches /tokens and /audit on an empty store without erroring", async () => {
    const client = new BrokerClient(origin);
    const tokens = await client.fetchTokens();
    const audit = await client.fetchAudit({ limit: 10 });
    expect(Array.isArray(tokens)).toBe(true);
    expect(Array.isArray(audit)).toBe(true);
  });

  it("surfaces transport errors as throws (callers can catch and render)", async () => {
    const dead = new BrokerClient("http://127.0.0.1:1");
    await expect(dead.fetchHealth()).rejects.toThrow();
  });
});
