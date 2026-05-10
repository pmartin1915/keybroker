import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { BrokerConfig } from "../src/config.js";
import type { StoreLike, TokenRecord } from "../src/store.js";

// Phase 2.4 fleet policy: integration tests against the full proxy.
//
// These are kept in a separate file from `proxy.test.ts` because they
// need to mutate `policy.json` mid-test, and because they need an
// independent broker so the policy file path is unique per suite (the
// policy module caches by absolute path).

let buildServer: typeof import("../src/server.js").buildServer;
let SqliteStore: typeof import("../src/store.js").SqliteStore;
let newTokenId: typeof import("../src/store.js").newTokenId;
let issueToken: typeof import("../src/tokens.js").issueToken;
let encrypt: typeof import("../src/crypto.js").encrypt;
let generateMasterKeyHex: typeof import("../src/crypto.js").generateMasterKeyHex;
let generateJwtSecret: typeof import("../src/crypto.js").generateJwtSecret;
let _resetPolicyCache: typeof import("../src/policy.js")._resetPolicyCache;

let upstream: Server;
let upstreamPort: number;
let app: FastifyInstance;
let brokerOrigin: string;
let config: BrokerConfig;
let store: StoreLike;
let dataDir: string;

function makeUpstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, body: body || null }));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as AddressInfo;
      resolve({ server: s, port: addr.port });
    });
  });
}

async function jsonError(res: Response): Promise<string> {
  const j = (await res.json()) as { error?: unknown };
  return String(j.error);
}

async function mintToken(opts: {
  scopes?: string[];
  maxCalls?: number;
  provider?: string;
  models?: string[];
} = {}): Promise<{ id: string; jwt: string }> {
  const id = newTokenId();
  const provider = opts.provider ?? "echo";
  const scopes = opts.scopes ?? ["*"];
  const max = opts.maxCalls ?? -1;
  const rec: TokenRecord = {
    id,
    provider,
    scopes,
    remaining: max,
    used: 0,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    createdAt: new Date().toISOString(),
    label: "test",
    revoked: false,
  };
  store.putToken(rec);
  const jwt = await issueToken(config.jwtSecret, {
    tokenId: id,
    provider,
    scopes,
    label: "test",
    ttlSeconds: 3600,
    models: opts.models,
  });
  return { id, jwt };
}

function writePolicy(policy: object): void {
  writeFileSync(config.policyPath, JSON.stringify(policy));
  // Drop the cache so the change is visible immediately within tests
  // without having to wait the 1s real-time TTL.
  _resetPolicyCache(config.policyPath);
}

function clearPolicy(): void {
  if (existsSync(config.policyPath)) unlinkSync(config.policyPath);
  _resetPolicyCache(config.policyPath);
}

beforeAll(async () => {
  const u = await makeUpstream();
  upstream = u.server;
  upstreamPort = u.port;
  process.env.KEYBROKER_ECHO_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

  ({ buildServer } = await import("../src/server.js"));
  ({ SqliteStore, newTokenId } = await import("../src/store.js"));
  ({ issueToken } = await import("../src/tokens.js"));
  ({ encrypt, generateMasterKeyHex, generateJwtSecret } = await import(
    "../src/crypto.js"
  ));
  ({ _resetPolicyCache } = await import("../src/policy.js"));

  dataDir = mkdtempSync(join(tmpdir(), "keybroker-policy-"));
  const masterKeyHex = generateMasterKeyHex();
  const jwtSecret = generateJwtSecret();
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
  };
  writeFileSync(
    config.configPath,
    JSON.stringify({ masterKeyHex, jwtSecret, port: 0, host: "127.0.0.1" }),
  );

  store = new SqliteStore(config.sqliteStorePath);
  store.putSecret("echo", {
    provider: "echo",
    ciphertext: encrypt("sk-fake-upstream", masterKeyHex),
    createdAt: new Date().toISOString(),
  });
  // Provide an openai secret too — test "provider_forbidden" needs us to
  // have a token issued for openai that would otherwise be valid.
  store.putSecret("openai", {
    provider: "openai",
    ciphertext: encrypt("sk-fake-openai", masterKeyHex),
    createdAt: new Date().toISOString(),
  });

  app = await buildServer(config, { logger: false, store });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  brokerOrigin = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
  store?.close?.();
  await new Promise<void>((r) => upstream?.close(() => r()));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearPolicy();
});

describe("policy: forbidden_models", () => {
  it("denies a model named exactly in forbidden_models with reason model_forbidden", async () => {
    writePolicy({ forbidden_models: ["gemini-3-pro-preview"] });
    const { id, jwt } = await mintToken();
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gemini-3-pro-preview", messages: [] }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_forbidden");
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const denial = recent.find(
      (e) => e.outcome === "denied" && e.reason === "model_forbidden",
    );
    expect(denial).toBeDefined();
    expect(denial?.requestedModel).toBe("gemini-3-pro-preview");
  });

  it("denies a model matching a glob pattern (`*-preview`)", async () => {
    writePolicy({ forbidden_models: ["*-preview"] });
    const { jwt } = await mintToken();
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "o1-preview", messages: [] }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_forbidden");
  });

  it("policy denial overrides a wildcard token (no mdl claim, scope:*)", async () => {
    writePolicy({ forbidden_models: ["forbidden-model"] });
    // Token has no mdl claim, scope is "*" — under Phase 2.1 alone this would
    // be allowed. Phase 2.4 policy must still deny.
    const { jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/anything`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "forbidden-model" }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_forbidden");
  });

  it("does not consume a quota slot when policy denies the model", async () => {
    writePolicy({ forbidden_models: ["bad"] });
    const { id, jwt } = await mintToken({ maxCalls: 1 });
    const r1 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "bad" }),
    });
    expect(r1.status).toBe(403);
    // The single quota slot should still be available.
    const tokenRow = store.listTokens().find((t) => t.id === id);
    expect(tokenRow?.remaining).toBe(1);
  });

  it("allows a model not on the forbidden list", async () => {
    writePolicy({ forbidden_models: ["*-preview"] });
    const { jwt } = await mintToken();
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("forbidden_models is enforced AHEAD OF scope (deny reported as policy, not scope)", async () => {
    // Scope explicitly disallows /v1/anything-else, but policy also forbids
    // the model. The roadmap says policy fires first.
    writePolicy({ forbidden_models: ["bad-model"] });
    const { jwt } = await mintToken({ scopes: ["GET:/v1/onlyget"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/anything-else`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "bad-model" }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_forbidden");
  });
});

describe("policy: allowed_providers", () => {
  it("denies a provider not in the allow-list with reason provider_forbidden", async () => {
    writePolicy({ allowed_providers: ["openai"] });
    // Token issued for echo (provider matches URL) but echo is not in the policy allow-list.
    const { jwt } = await mintToken({ provider: "echo" });
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("provider_forbidden");
  });

  it("allows a provider in the allow-list", async () => {
    writePolicy({ allowed_providers: ["echo"] });
    const { jwt } = await mintToken({ provider: "echo" });
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("provider_forbidden fires before scope_denied", async () => {
    writePolicy({ allowed_providers: ["openai"] });
    // Scope would deny too, but provider denial should win.
    const { jwt } = await mintToken({ provider: "echo", scopes: ["GET:/never"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("provider_forbidden");
  });
});

describe("policy: hot reload", () => {
  it("changes take effect within a second of editing policy.json", async () => {
    // No policy → request succeeds.
    const { jwt } = await mintToken();
    const r1 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "ramp-target" }),
    });
    expect(r1.status).toBe(200);

    // Add the model to the deny-list. We rely on the cache invalidation
    // that writePolicy() does (a real edit by an operator would just wait
    // up to 1s for the TTL).
    writePolicy({ forbidden_models: ["ramp-target"] });
    const r2 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "ramp-target" }),
    });
    expect(r2.status).toBe(403);
    expect(await jsonError(r2)).toBe("model_forbidden");
  });

  it(
    "real-time TTL: a policy edit takes effect within ~1.2s without manual cache invalidation",
    async () => {
      const { jwt } = await mintToken();
      // Seed the cache with no-policy by issuing one call.
      const r0 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "real-time-target" }),
      });
      expect(r0.status).toBe(200);

      // Write the policy file directly — do NOT touch the cache.
      writeFileSync(
        config.policyPath,
        JSON.stringify({ forbidden_models: ["real-time-target"] }),
      );

      // Wait past the 1s TTL.
      await new Promise((r) => setTimeout(r, 1200));

      const r1 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "real-time-target" }),
      });
      expect(r1.status).toBe(403);
      expect(await jsonError(r1)).toBe("model_forbidden");
    },
    5000,
  );
});

describe("policy + per-token mdl interaction", () => {
  it("per-token mdl is glob-matched (Phase 2.4 upgrade)", async () => {
    // Token allows any gpt-4o-mini-* variant via glob.
    const { jwt } = await mintToken({ models: ["gpt-4o-mini*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini-2024-07-18" }),
    });
    expect(res.status).toBe(200);
  });

  it("policy can deny a model that the token's mdl claim allows (policy wins)", async () => {
    writePolicy({ forbidden_models: ["gpt-4o-mini"] });
    const { jwt } = await mintToken({ models: ["gpt-4o-mini"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini" }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_forbidden");
  });
});
