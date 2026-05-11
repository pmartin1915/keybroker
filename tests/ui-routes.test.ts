import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { SqliteStore, newTokenId, type TokenRecord } from "../src/store.js";
import { generateMasterKeyHex, generateJwtSecret } from "../src/crypto.js";
import type { BrokerConfig } from "../src/config.js";
import type { CallLogEntry } from "../src/logging.js";

// Phase 4.0 c2: the broker exposes `GET /tokens` and `GET /audit` for
// the bundled control plane to fetch. Both inherit the open-on-127.0.0.1
// trust posture of /metrics/spend and /forecast/*. These tests cover
// shape, filtering, and the `spendUsd` augmentation on token rows.

let app: FastifyInstance;
let origin: string;
let dataDir: string;
let store: SqliteStore;

function makeToken(rec: Partial<TokenRecord> = {}): TokenRecord {
  const id = rec.id ?? newTokenId();
  return {
    id,
    provider: rec.provider ?? "echo",
    scopes: rec.scopes ?? ["*"],
    remaining: rec.remaining ?? -1,
    used: rec.used ?? 0,
    expiresAt: rec.expiresAt ?? 0,
    createdAt: rec.createdAt ?? new Date().toISOString(),
    label: rec.label ?? "test",
    revoked: rec.revoked ?? false,
    ...(rec.machine !== undefined ? { machine: rec.machine } : {}),
    ...(rec.capUsd !== undefined ? { capUsd: rec.capUsd } : {}),
    ...(rec.tagTeam !== undefined ? { tagTeam: rec.tagTeam } : {}),
    ...(rec.tagProject !== undefined ? { tagProject: rec.tagProject } : {}),
    ...(rec.tagEnv !== undefined ? { tagEnv: rec.tagEnv } : {}),
    ...(rec.models !== undefined ? { models: rec.models } : {}),
  };
}

function makeCall(over: Partial<CallLogEntry>): CallLogEntry {
  return {
    ts: over.ts ?? new Date().toISOString(),
    tokenId: over.tokenId ?? "tok-x",
    label: over.label ?? "test",
    provider: over.provider ?? "echo",
    method: over.method ?? "POST",
    path: over.path ?? "/v1/chat/completions",
    status: over.status ?? 200,
    durationMs: over.durationMs ?? 100,
    reqBytes: over.reqBytes ?? 200,
    respBytes: over.respBytes ?? 400,
    outcome: over.outcome ?? "ok",
    ...(over.reason !== undefined ? { reason: over.reason } : {}),
    ...(over.machine !== undefined ? { machine: over.machine } : {}),
    ...(over.actualCostUsd !== undefined ? { actualCostUsd: over.actualCostUsd } : {}),
    ...(over.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: over.estimatedCostUsd }
      : {}),
    ...(over.tagTeam !== undefined ? { tagTeam: over.tagTeam } : {}),
    ...(over.tagProject !== undefined ? { tagProject: over.tagProject } : {}),
    ...(over.tagEnv !== undefined ? { tagEnv: over.tagEnv } : {}),
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-ui-routes-"));
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

  // Seed: three tokens, one revoked, varied tags and machines.
  store.putToken(makeToken({ id: "tok-a", label: "demo-a", tagTeam: "platform", machine: "host-1", capUsd: 5 }));
  store.putToken(makeToken({ id: "tok-b", label: "demo-b", tagTeam: "data", machine: "host-2" }));
  store.putToken(makeToken({ id: "tok-c", label: "demo-c", revoked: true, machine: "host-1" }));

  // Seed: audit calls — mix of outcomes, two machines, two tokens.
  store.appendCall(
    makeCall({
      tokenId: "tok-a",
      label: "demo-a",
      outcome: "ok",
      machine: "host-1",
      actualCostUsd: 1.25,
      tagTeam: "platform",
    }),
  );
  store.appendCall(
    makeCall({
      tokenId: "tok-a",
      label: "demo-a",
      outcome: "ok",
      machine: "host-1",
      actualCostUsd: 0.75,
      tagTeam: "platform",
    }),
  );
  store.appendCall(
    makeCall({
      tokenId: "tok-b",
      label: "demo-b",
      outcome: "denied",
      reason: "scope_denied",
      machine: "host-2",
      tagTeam: "data",
    }),
  );
  store.appendCall(
    makeCall({
      tokenId: "tok-b",
      label: "demo-b",
      outcome: "egress_blocked",
      reason: "aws_access_key",
      machine: "host-2",
      tagTeam: "data",
    }),
  );

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

describe("GET /tokens", () => {
  it("returns all tokens with spendUsd augmentation", async () => {
    const res = await fetch(`${origin}/tokens`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; spendUsd: number; revoked: boolean }>;
    expect(body).toHaveLength(3);
    const byId = Object.fromEntries(body.map((r) => [r.id, r]));
    // tok-a has two priced ok calls totalling 2.00.
    expect(byId["tok-a"]?.spendUsd).toBeCloseTo(2.0);
    // tok-b's calls were denied + egress_blocked → no spend.
    expect(byId["tok-b"]?.spendUsd).toBeCloseTo(0);
    // tok-c had no calls.
    expect(byId["tok-c"]?.spendUsd).toBeCloseTo(0);
    expect(byId["tok-c"]?.revoked).toBe(true);
  });

  it("filters by machine", async () => {
    const res = await fetch(`${origin}/tokens?machine=host-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; machine?: string }>;
    expect(body.map((r) => r.id).sort()).toEqual(["tok-a", "tok-c"]);
    for (const row of body) expect(row.machine).toBe("host-1");
  });
});

describe("GET /policy", () => {
  it("returns the active policy snapshot", async () => {
    const res = await fetch(`${origin}/policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      forbiddenModels?: unknown;
      allowedProviders?: unknown;
      tagAllowlist?: unknown;
      scanner?: { enabled?: unknown };
    };
    // The test seeds no policy.json, so the broker falls back to the
    // empty-policy defaults defined in src/policy.ts. The scanner is
    // default-on (Phase 3.6 invariant) regardless of file presence.
    expect(Array.isArray(body.forbiddenModels)).toBe(true);
    expect(Array.isArray(body.allowedProviders)).toBe(true);
    expect(typeof body.tagAllowlist).toBe("object");
    expect(body.scanner?.enabled).toBe(true);
  });
});

describe("GET /audit", () => {
  it("returns recent calls in recency order", async () => {
    const res = await fetch(`${origin}/audit`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ ts: string; outcome: string }>;
    expect(body).toHaveLength(4);
    const outcomes = new Set(body.map((r) => r.outcome));
    expect(outcomes).toContain("ok");
    expect(outcomes).toContain("denied");
    expect(outcomes).toContain("egress_blocked");
  });

  it("honors ?limit=", async () => {
    const res = await fetch(`${origin}/audit?limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<unknown>;
    expect(body).toHaveLength(2);
  });

  it("rejects out-of-range limit", async () => {
    const res = await fetch(`${origin}/audit?limit=999999`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_limit");
  });

  it("filters by token", async () => {
    const res = await fetch(`${origin}/audit?token=tok-a`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ tokenId: string }>;
    expect(body).toHaveLength(2);
    for (const row of body) expect(row.tokenId).toBe("tok-a");
  });

  it("filters by machine", async () => {
    const res = await fetch(`${origin}/audit?machine=host-2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ machine?: string; outcome: string }>;
    expect(body).toHaveLength(2);
    const outcomes = body.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["denied", "egress_blocked"]);
  });
});
