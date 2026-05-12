import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { SqliteStore } from "../src/store.js";
import { generateMasterKeyHex, generateJwtSecret } from "../src/crypto.js";
import { issueManagementToken } from "../src/tokens.js";
import type { BrokerConfig } from "../src/config.js";
import { BrokerClient, MgmtAuthError } from "../tui/src/api/client.js";

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
let mgmtSecret: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-tui-"));
  const masterKeyHex = generateMasterKeyHex();
  const jwtSecret = generateJwtSecret();
  mgmtSecret = generateJwtSecret();
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
    mgmtSecret,
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

// ─────────────────────────────────────────────────────────────────────
// Phase 4.1 c4 — admin client contract. Mirrors web's MgmtAuthError /
// issueProxyToken / revokeProxyToken / probeMgmtToken semantics.
// ─────────────────────────────────────────────────────────────────────

async function mintMgmtJwt(label = "tui-test"): Promise<string> {
  return issueManagementToken(mgmtSecret, {
    tokenId: `mgmt-${Math.random().toString(36).slice(2, 10)}`,
    label,
    ttlSeconds: 3600,
  });
}

describe("BrokerClient (TUI) — admin surface (Phase 4.1 c4)", () => {
  it("issueProxyToken throws MgmtAuthError synchronously when no token is set", async () => {
    const client = new BrokerClient(origin);
    await expect(
      client.issueProxyToken({ provider: "echo" }),
    ).rejects.toBeInstanceOf(MgmtAuthError);
    // The cache stays clean — no token was set in the first place.
    expect(client.hasMgmtToken()).toBe(false);
  });

  it("issueProxyToken throws MgmtAuthError on 401 and clears the cached token", async () => {
    const client = new BrokerClient(origin);
    // brkm_-prefixed but bogus payload — passes the client-side prefix
    // guard, fails server-side verify.
    client.setMgmtToken("brkm_not_a_real_jwt");
    expect(client.hasMgmtToken()).toBe(true);
    await expect(
      client.issueProxyToken({ provider: "echo" }),
    ).rejects.toBeInstanceOf(MgmtAuthError);
    // Cache must be dropped so the next call re-prompts the operator.
    expect(client.hasMgmtToken()).toBe(false);
  });

  it("issueProxyToken with a valid mgmt JWT round-trips and the new token appears in /tokens", async () => {
    const client = new BrokerClient(origin);
    client.setMgmtToken(await mintMgmtJwt());

    const before = await client.fetchTokens();
    const issued = await client.issueProxyToken({
      provider: "echo",
      label: "c4-issue-test",
      ttlSeconds: 3600,
    });

    expect(issued.tokenId).toBeTypeOf("string");
    expect(issued.jwt.length).toBeGreaterThan(20);
    expect(issued.record.provider).toBe("echo");
    expect(issued.record.label).toBe("c4-issue-test");
    expect(issued.record.revoked).toBe(false);

    const after = await client.fetchTokens();
    expect(after.length).toBe(before.length + 1);
    expect(after.find((r) => r.id === issued.tokenId)?.label).toBe("c4-issue-test");
  });

  it("revokeProxyToken returns idempotent ok and flips the row revoked flag", async () => {
    const client = new BrokerClient(origin);
    client.setMgmtToken(await mintMgmtJwt());
    const issued = await client.issueProxyToken({
      provider: "echo",
      label: "c4-revoke-test",
      ttlSeconds: 3600,
    });

    const first = await client.revokeProxyToken(issued.tokenId);
    expect(first.revoked).toBe(true);
    expect(first.id).toBe(issued.tokenId);
    expect(first.alreadyRevoked).toBeUndefined();

    // Idempotent: a second revoke is OK and flagged alreadyRevoked.
    const second = await client.revokeProxyToken(issued.tokenId);
    expect(second.revoked).toBe(true);
    expect(second.alreadyRevoked).toBe(true);

    const after = await client.fetchTokens();
    expect(after.find((r) => r.id === issued.tokenId)?.revoked).toBe(true);
  });

  it("revokeProxyToken throws non-MgmtAuthError on 404 (unknown id)", async () => {
    const client = new BrokerClient(origin);
    client.setMgmtToken(await mintMgmtJwt());
    await expect(
      client.revokeProxyToken("no-such-token-id"),
    ).rejects.toThrow(/unknown_token/);
  });

  it("probeMgmtToken returns ok for a freshly-minted mgmt JWT WITHOUT committing it", async () => {
    const client = new BrokerClient(origin);
    expect(client.hasMgmtToken()).toBe(false);
    const tok = await mintMgmtJwt();
    const res = await client.probeMgmtToken(tok);
    expect(res.ok).toBe(true);
    // probe does not commit — caller decides via setMgmtToken.
    expect(client.hasMgmtToken()).toBe(false);
  });

  it("probeMgmtToken rejects tokens missing the brkm_ prefix", async () => {
    const client = new BrokerClient(origin);
    const res = await client.probeMgmtToken("brk_proxy_token_not_mgmt");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("missing_brkm_prefix");
  });

  it("probeMgmtToken rejects brkm_-prefixed bogus payloads with the broker's reason", async () => {
    const client = new BrokerClient(origin);
    const res = await client.probeMgmtToken("brkm_not_a_real_jwt");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Broker returns 401 + { error: "invalid_management_token" }; the
      // probe surfaces the broker's `error` tag as `reason`.
      expect(res.reason).toMatch(/invalid_management_token|missing_prefix/);
    }
  });

  it("clearMgmtToken forgets the cached token without affecting subsequent setMgmtToken calls", async () => {
    const client = new BrokerClient(origin);
    client.setMgmtToken(await mintMgmtJwt());
    expect(client.hasMgmtToken()).toBe(true);
    client.clearMgmtToken();
    expect(client.hasMgmtToken()).toBe(false);
    client.setMgmtToken(await mintMgmtJwt());
    expect(client.hasMgmtToken()).toBe(true);
  });
});
