import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { SqliteStore, newTokenId, type TokenRecord } from "../src/store.js";
import {
  generateMasterKeyHex,
  generateJwtSecret,
  encrypt,
} from "../src/crypto.js";
import type { BrokerConfig } from "../src/config.js";
import {
  issueManagementToken,
  issueToken,
  verifyManagementToken,
  MGMT_TOKEN_PREFIX,
} from "../src/tokens.js";

// Phase 4.0 c4: admin routes — POST /admin/tokens (issue), DELETE
// /admin/tokens/:id (revoke), POST /admin/tokens/rotate (rotate-all
// over HTTP). All three sit behind a separate signing secret
// (`config.mgmtSecret`) so the proxy axis and the write axis have
// independent blast radii.

let app: FastifyInstance;
let origin: string;
let dataDir: string;
let store: SqliteStore;
let config: BrokerConfig;
let mgmtJwt: string;

function makeToken(rec: Partial<TokenRecord> = {}): TokenRecord {
  const id = rec.id ?? newTokenId();
  return {
    id,
    provider: rec.provider ?? "echo",
    scopes: rec.scopes ?? ["*"],
    remaining: rec.remaining ?? -1,
    used: rec.used ?? 0,
    expiresAt: rec.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-admin-"));
  const masterKeyHex = generateMasterKeyHex();
  const jwtSecret = generateJwtSecret();
  const mgmtSecret = generateJwtSecret();
  config = {
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
    JSON.stringify({ port: 0, host: "127.0.0.1" }),
  );
  store = new SqliteStore(config.sqliteStorePath);
  // Seed an echo upstream secret so `issueTokenFlow` -> issued proxy
  // tokens land in a fully-functional broker for any callers that
  // want to round-trip after a mgmt issue.
  store.putSecret("echo", {
    provider: "echo",
    ciphertext: encrypt("upstream-key", masterKeyHex),
    createdAt: new Date().toISOString(),
  });
  app = await buildServer(config, { logger: false, store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;

  mgmtJwt = await issueManagementToken(mgmtSecret, {
    tokenId: "mgmt-test",
    label: "admin-test",
    ttlSeconds: 3600,
  });
});

afterAll(async () => {
  await app?.close();
  store?.close?.();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// Management JWT round-trip — mint / verify / prefix invariants.
// ─────────────────────────────────────────────────────────────────────

describe("management JWT primitives", () => {
  it("mints with the brkm_ prefix", () => {
    expect(mgmtJwt.startsWith(MGMT_TOKEN_PREFIX)).toBe(true);
  });

  it("verifies with the same secret", async () => {
    const r = await verifyManagementToken(config.mgmtSecret, mgmtJwt);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error("unreachable");
    expect(r.claims.scope).toBe("manage");
    expect(r.claims.lbl).toBe("admin-test");
  });

  it("rejects when signed with the wrong secret", async () => {
    const r = await verifyManagementToken(generateJwtSecret(), mgmtJwt);
    expect("error" in r).toBe(true);
  });

  it("rejects a proxy JWT presented as a management token (prefix)", async () => {
    const proxyJwt = await issueToken(config.jwtSecret, {
      tokenId: "proxy-1",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 60,
    });
    // A `brk_` token presented to verifyManagementToken hits the
    // prefix guard before the signing-key check.
    const r = await verifyManagementToken(config.mgmtSecret, proxyJwt);
    expect(r).toEqual({ error: "missing_prefix" });
  });

  it("refuses to mint with non-positive TTL", async () => {
    await expect(
      issueManagementToken(config.mgmtSecret, {
        tokenId: "x",
        label: "x",
        ttlSeconds: 0,
      }),
    ).rejects.toThrow(/must be > 0/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Auth gating — every admin route must require a valid mgmt token.
// ─────────────────────────────────────────────────────────────────────

describe("admin routes auth gating", () => {
  const cases: Array<{ method: string; path: string }> = [
    { method: "POST", path: "/admin/tokens" },
    { method: "DELETE", path: "/admin/tokens/anything" },
    { method: "POST", path: "/admin/tokens/rotate" },
  ];

  for (const c of cases) {
    it(`401s ${c.method} ${c.path} with no Authorization header`, async () => {
      const res = await fetch(`${origin}${c.path}`, {
        method: c.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("no_management_token");
    });

    it(`401s ${c.method} ${c.path} with a proxy (brk_) token`, async () => {
      const proxyJwt = await issueToken(config.jwtSecret, {
        tokenId: "proxy-x",
        provider: "echo",
        scopes: ["*"],
        label: "x",
        ttlSeconds: 60,
      });
      const res = await fetch(`${origin}${c.path}`, {
        method: c.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${proxyJwt}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    it(`401s ${c.method} ${c.path} with a tampered mgmt token`, async () => {
      // Flip one char inside the JWT payload section so the signature
      // no longer verifies.
      const idx = mgmtJwt.length - 10;
      const ch = mgmtJwt.charAt(idx);
      const tampered = mgmtJwt.slice(0, idx) + (ch === "A" ? "B" : "A") + mgmtJwt.slice(idx + 1);
      const res = await fetch(`${origin}${c.path}`, {
        method: c.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tampered}`,
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /admin/tokens — issue a new proxy token.
// ─────────────────────────────────────────────────────────────────────

describe("POST /admin/tokens", () => {
  it("issues a proxy token with minimal body", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ provider: "echo", label: "via-http" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      tokenId: string;
      jwt: string;
      record: TokenRecord;
    };
    expect(body.tokenId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.jwt.startsWith("brk_")).toBe(true);
    expect(body.record.provider).toBe("echo");
    expect(body.record.label).toBe("via-http");
    // The token was persisted to the store as a side effect.
    expect(store.getToken(body.tokenId)?.label).toBe("via-http");
  });

  it("400s on unknown provider", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ provider: "does-not-exist", label: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_provider");
  });

  it("400s on missing provider", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_provider");
  });

  it("persists tags and cap when supplied", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({
        provider: "echo",
        label: "tagged",
        capUsd: 5,
        tags: { team: "platform", project: "broker" },
        ttlSeconds: 60,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record: TokenRecord };
    expect(body.record.capUsd).toBe(5);
    expect(body.record.tagTeam).toBe("platform");
    expect(body.record.tagProject).toBe("broker");
  });
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /admin/tokens/:id — revoke.
// ─────────────────────────────────────────────────────────────────────

describe("DELETE /admin/tokens/:id", () => {
  it("revokes an active token", async () => {
    const rec = makeToken({ label: "to-revoke" });
    store.putToken(rec);
    const res = await fetch(`${origin}/admin/tokens/${rec.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean; id: string };
    expect(body.revoked).toBe(true);
    expect(body.id).toBe(rec.id);
    expect(store.getToken(rec.id)?.revoked).toBe(true);
  });

  it("returns 200 idempotently when already revoked", async () => {
    const rec = makeToken({ label: "double-revoke", revoked: true });
    store.putToken(rec);
    const res = await fetch(`${origin}/admin/tokens/${rec.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alreadyRevoked?: boolean };
    expect(body.alreadyRevoked).toBe(true);
  });

  it("404s on unknown id", async () => {
    const res = await fetch(`${origin}/admin/tokens/does-not-exist`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_token");
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /admin/tokens/rotate — preview / dryRun / real-run.
// ─────────────────────────────────────────────────────────────────────

describe("POST /admin/tokens/rotate", () => {
  it("400s with no filters", async () => {
    const res = await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ filters: {} }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_filters");
  });

  it("preview returns counts without writing", async () => {
    store.putToken(makeToken({ id: "rot-a", tagTeam: "rotteam", label: "ra" }));
    store.putToken(makeToken({ id: "rot-b", tagTeam: "rotteam", label: "rb" }));
    const res = await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ filters: { team: "rotteam" }, preview: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      preview: { total: number; byTeam: Record<string, number> };
    };
    expect(body.preview.total).toBe(2);
    expect(body.preview.byTeam.rotteam).toBe(2);
    // Sanity: no rotation occurred.
    expect(store.getToken("rot-a")?.revoked).toBe(false);
    expect(store.getToken("rot-b")?.revoked).toBe(false);
  });

  it("dryRun returns the plan without writing", async () => {
    store.putToken(makeToken({ id: "rot-c", tagTeam: "dryteam", label: "rc" }));
    const res = await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ filters: { team: "dryteam" }, dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: Array<{ oldId: string; newId: string; label: string }>;
    };
    expect(body.plan).toHaveLength(1);
    expect(body.plan[0]?.oldId).toBe("rot-c");
    expect(store.getToken("rot-c")?.revoked).toBe(false);
  });

  it("real run revokes + reissues with identical claims", async () => {
    store.putToken(
      makeToken({
        id: "rot-d",
        tagTeam: "realteam",
        label: "rd",
        capUsd: 2.5,
        models: ["gpt-4o-mini"],
      }),
    );
    const res = await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ filters: { team: "realteam" } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      revoked: number;
      reissued: Array<{ oldId: string; newId: string; jwt: string }>;
    };
    expect(body.revoked).toBe(1);
    expect(body.reissued).toHaveLength(1);
    const r = body.reissued[0]!;
    expect(r.oldId).toBe("rot-d");
    expect(r.jwt.startsWith("brk_")).toBe(true);
    // Old token revoked.
    expect(store.getToken("rot-d")?.revoked).toBe(true);
    // New token persisted with the same cap + model claim preserved.
    const newRec = store.getToken(r.newId);
    expect(newRec?.tagTeam).toBe("realteam");
    expect(newRec?.capUsd).toBe(2.5);
    expect(newRec?.models).toEqual(["gpt-4o-mini"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 4.0 c4e: admin audit log.
// ─────────────────────────────────────────────────────────────────────

import type { AdminAuditEntry } from "../src/store-types.js";

describe("admin audit log", () => {
  // ── Auth gating ────────────────────────────────────────────────────

  it("GET /admin/audit 401s with no Authorization header", async () => {
    const res = await fetch(`${origin}/admin/audit`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_management_token");
  });

  it("GET /admin/audit 401s with a proxy (brk_) token", async () => {
    const proxyJwt = await issueToken(config.jwtSecret, {
      tokenId: "audit-proxy-check",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 60,
    });
    const res = await fetch(`${origin}/admin/audit`, {
      headers: { authorization: `Bearer ${proxyJwt}` },
    });
    expect(res.status).toBe(401);
  });

  // ── token.issue audit rows ─────────────────────────────────────────

  it("records an ok audit row after POST /admin/tokens succeeds", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ provider: "echo", label: "audit-issue-test" }),
    });
    expect(res.status).toBe(201);
    const issued = (await res.json()) as { tokenId: string };

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      rows: AdminAuditEntry[];
    };
    // Find the row matching this issue action.
    const row = auditBody.rows.find(
      (r) =>
        r.action === "token.issue" &&
        r.targetTokenId === issued.tokenId &&
        r.outcome === "ok",
    );
    expect(row).toBeDefined();
    expect(row?.actorTokenId).toBe("mgmt-test");
    expect(row?.actorLabel).toBe("admin-test");
  });

  it("paramsJson of an issue row does NOT contain jwt bytes (invariant 3)", async () => {
    const res = await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ provider: "echo", label: "audit-params-check" }),
    });
    expect(res.status).toBe(201);
    const issued = (await res.json()) as { tokenId: string };

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const auditBody = (await auditRes.json()) as { rows: AdminAuditEntry[] };
    const row = auditBody.rows.find(
      (r) => r.action === "token.issue" && r.targetTokenId === issued.tokenId,
    );
    expect(row).toBeDefined();
    // paramsJson must never include the resulting JWT.
    expect(row?.paramsJson).not.toContain("jwt");
    expect(row?.paramsJson).not.toContain("brk_");
  });

  it("records a failed audit row when POST /admin/tokens fails (unknown provider)", async () => {
    await fetch(`${origin}/admin/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ provider: "no-such-provider", label: "audit-fail" }),
    });

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const auditBody = (await auditRes.json()) as { rows: AdminAuditEntry[] };
    const row = auditBody.rows.find(
      (r) =>
        r.action === "token.issue" &&
        r.outcome === "failed" &&
        r.reason === "unknown_provider",
    );
    expect(row).toBeDefined();
    expect(row?.actorTokenId).toBe("mgmt-test");
  });

  // ── token.revoke audit rows ────────────────────────────────────────

  it("records an ok audit row after DELETE /admin/tokens/:id revokes", async () => {
    const rec = makeToken({ label: "audit-revoke-test" });
    store.putToken(rec);
    await fetch(`${origin}/admin/tokens/${rec.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const auditBody = (await auditRes.json()) as { rows: AdminAuditEntry[] };
    const row = auditBody.rows.find(
      (r) =>
        r.action === "token.revoke" &&
        r.targetTokenId === rec.id &&
        r.outcome === "ok",
    );
    expect(row).toBeDefined();
    expect(row?.actorTokenId).toBe("mgmt-test");
  });

  it("records a failed audit row when DELETE /admin/tokens/:id 404s (unknown id)", async () => {
    await fetch(`${origin}/admin/tokens/audit-unknown-id`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const auditBody = (await auditRes.json()) as { rows: AdminAuditEntry[] };
    const row = auditBody.rows.find(
      (r) =>
        r.action === "token.revoke" &&
        r.targetTokenId === "audit-unknown-id" &&
        r.outcome === "failed" &&
        r.reason === "unknown_token",
    );
    expect(row).toBeDefined();
  });

  // ── token.rotate audit rows ────────────────────────────────────────

  it("records a token.rotate audit row after a real-run rotate", async () => {
    store.putToken(
      makeToken({ id: "audit-rot-a", tagTeam: "auditteam", label: "ara" }),
    );
    store.putToken(
      makeToken({ id: "audit-rot-b", tagTeam: "auditteam", label: "arb" }),
    );

    const res = await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({ filters: { team: "auditteam" } }),
    });
    expect(res.status).toBe(200);
    const rotBody = (await res.json()) as { reissued: unknown[] };

    const auditRes = await fetch(`${origin}/admin/audit?limit=50`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const auditBody = (await auditRes.json()) as { rows: AdminAuditEntry[] };
    const row = auditBody.rows.find(
      (r) => r.action === "token.rotate" && r.outcome === "ok",
    );
    expect(row).toBeDefined();
    expect(row?.targetCount).toBe(rotBody.reissued.length);
    expect(row?.actorTokenId).toBe("mgmt-test");
    // paramsJson should reference the filters, never the new JWTs.
    expect(row?.paramsJson).toContain("auditteam");
    expect(row?.paramsJson).not.toContain("jwt");
  });

  it("preview rotate does NOT produce an audit row (invariant 6)", async () => {
    store.putToken(
      makeToken({ id: "audit-prev-a", tagTeam: "previewteam", label: "pva" }),
    );

    // Snapshot audit count before.
    const before = await fetch(`${origin}/admin/audit?limit=200`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const beforeBody = (await before.json()) as { rows: AdminAuditEntry[] };
    const countBefore = beforeBody.rows.length;

    await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({
        filters: { team: "previewteam" },
        preview: true,
      }),
    });

    const after = await fetch(`${origin}/admin/audit?limit=200`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const afterBody = (await after.json()) as { rows: AdminAuditEntry[] };
    // No new rotate row should have been added.
    expect(afterBody.rows.length).toBe(countBefore);
  });

  it("dryRun rotate does NOT produce an audit row (invariant 6)", async () => {
    store.putToken(
      makeToken({ id: "audit-dry-a", tagTeam: "dryrunteam", label: "dra" }),
    );

    const before = await fetch(`${origin}/admin/audit?limit=200`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const beforeBody = (await before.json()) as { rows: AdminAuditEntry[] };
    const countBefore = beforeBody.rows.length;

    await fetch(`${origin}/admin/tokens/rotate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mgmtJwt}`,
      },
      body: JSON.stringify({
        filters: { team: "dryrunteam" },
        dryRun: true,
      }),
    });

    const after = await fetch(`${origin}/admin/audit?limit=200`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const afterBody = (await after.json()) as { rows: AdminAuditEntry[] };
    expect(afterBody.rows.length).toBe(countBefore);
  });

  // ── Pagination ─────────────────────────────────────────────────────

  it("beforeId cursor pagination: no overlap between pages", async () => {
    // Issue 3 fresh tokens so we have at least 3 new issue audit rows
    // to paginate through.
    const issued: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${origin}/admin/tokens`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mgmtJwt}`,
        },
        body: JSON.stringify({ provider: "echo", label: `page-tok-${i}` }),
      });
      const b = (await res.json()) as { tokenId: string };
      issued.push(b.tokenId);
    }

    // First page: limit=2, no cursor — should return newest rows first.
    const page1Res = await fetch(`${origin}/admin/audit?limit=2`, {
      headers: { authorization: `Bearer ${mgmtJwt}` },
    });
    const page1 = (await page1Res.json()) as {
      rows: AdminAuditEntry[];
      nextBeforeId?: number;
    };
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextBeforeId).toBeDefined();

    // Second page: use the cursor from page 1.
    const page2Res = await fetch(
      `${origin}/admin/audit?limit=2&beforeId=${page1.nextBeforeId}`,
      { headers: { authorization: `Bearer ${mgmtJwt}` } },
    );
    const page2 = (await page2Res.json()) as { rows: AdminAuditEntry[] };
    expect(page2.rows.length).toBeGreaterThan(0);

    // No row id should appear in both pages.
    const ids1 = new Set(page1.rows.map((r) => r.id));
    for (const r of page2.rows) {
      expect(ids1.has(r.id)).toBe(false);
    }

    // All page-2 rows must have id < page-1's cursor.
    const cursor = page1.nextBeforeId!;
    for (const r of page2.rows) {
      expect((r.id ?? 0) < cursor).toBe(true);
    }
  });
});
