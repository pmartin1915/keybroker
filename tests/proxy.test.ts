import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { BrokerConfig } from "../src/config.js";
import type { StoreLike, TokenRecord } from "../src/store.js";

// These must be loaded *after* KEYBROKER_ECHO_BASE_URL is set, because
// providers/index.ts captures the echo baseUrl at module load time.
let buildServer: typeof import("../src/server.js").buildServer;
let SqliteStore: typeof import("../src/store.js").SqliteStore;
let newTokenId: typeof import("../src/store.js").newTokenId;
let issueToken: typeof import("../src/tokens.js").issueToken;
let encrypt: typeof import("../src/crypto.js").encrypt;
let generateMasterKeyHex: typeof import("../src/crypto.js").generateMasterKeyHex;
let generateJwtSecret: typeof import("../src/crypto.js").generateJwtSecret;

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
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            authorization: req.headers["authorization"] ?? null,
            body: body || null,
          }),
        );
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
  ttlSeconds?: number;
  provider?: string;
  revoked?: boolean;
  models?: string[];
}): Promise<{ id: string; jwt: string }> {
  const id = newTokenId();
  const provider = opts.provider ?? "echo";
  const scopes = opts.scopes ?? ["*"];
  const ttl = opts.ttlSeconds ?? 600;
  const max = opts.maxCalls ?? -1;
  const rec: TokenRecord = {
    id,
    provider,
    scopes,
    remaining: max,
    used: 0,
    expiresAt: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0,
    createdAt: new Date().toISOString(),
    label: "test",
    revoked: opts.revoked ?? false,
  };
  store.putToken(rec);
  const jwt = await issueToken(config.jwtSecret, {
    tokenId: id,
    provider,
    scopes,
    label: "test",
    ttlSeconds: ttl,
    models: opts.models,
  });
  return { id, jwt };
}

beforeAll(async () => {
  // 1. Boot upstream and pin its URL into KEYBROKER_ECHO_BASE_URL.
  const u = await makeUpstream();
  upstream = u.server;
  upstreamPort = u.port;
  process.env.KEYBROKER_ECHO_BASE_URL = `http://127.0.0.1:${upstreamPort}`;

  // 2. Now load the broker modules (echo provider's baseUrl freezes on first import).
  ({ buildServer } = await import("../src/server.js"));
  ({ SqliteStore, newTokenId } = await import("../src/store.js"));
  ({ issueToken } = await import("../src/tokens.js"));
  ({ encrypt, generateMasterKeyHex, generateJwtSecret } = await import(
    "../src/crypto.js"
  ));

  // 3. Sanity: confirm the override was honored. If the user already had
  // a process holding the default echo port, we would silently fall back.
  const providers = await import("../src/providers/index.js");
  expect(providers.PROVIDERS["echo"]?.baseUrl).toBe(
    `http://127.0.0.1:${upstreamPort}`,
  );

  // 4. Build a per-test config in a fresh tmp dir.
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-test-"));
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
  // Touch a config file so anything that re-loads finds it.
  writeFileSync(
    config.configPath,
    JSON.stringify({ masterKeyHex, jwtSecret, port: 0, host: "127.0.0.1" }),
  );

  // 5. Seed the store with an encrypted echo upstream secret.
  store = new SqliteStore(config.sqliteStorePath);
  store.putSecret("echo", {
    provider: "echo",
    ciphertext: encrypt("sk-fake-upstream", masterKeyHex),
    createdAt: new Date().toISOString(),
  });

  // 6. Start the broker on an ephemeral port. Inject the same store instance
  // so we can both seed it from the test and have the server read from it.
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

describe("proxy: happy path", () => {
  it("forwards a POST and swaps the bearer token", async () => {
    const { jwt } = await mintToken({
      scopes: ["POST:/v1/"],
      maxCalls: 5,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/hello`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ hi: "there" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      method: string;
      url: string;
      authorization: string | null;
      body: string | null;
    };
    expect(body.method).toBe("POST");
    expect(body.url).toBe("/v1/hello");
    expect(body.authorization).toBe("Bearer sk-fake-upstream");
    expect(body.body).toBe('{"hi":"there"}');
  });
});

describe("proxy: token enforcement", () => {
  it("returns 401 when no token is presented", async () => {
    const res = await fetch(`${brokerOrigin}/echo/v1/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await jsonError(res)).toBe("no_token");
  });

  it("returns 401 for a revoked token", async () => {
    const { jwt } = await mintToken({
      scopes: ["*"],
      maxCalls: 5,
      revoked: true,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/anything`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await jsonError(res)).toBe("revoked");
  });

  it("returns 401 for a tampered token signature", async () => {
    const { jwt } = await mintToken({ scopes: ["*"] });
    // Flip one char near the end (signature) to break verification.
    const idx = jwt.length - 5;
    const ch = jwt.charAt(idx);
    const swap = ch === "A" ? "B" : "A";
    const bad = jwt.slice(0, idx) + swap + jwt.slice(idx + 1);
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bad}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(await jsonError(res)).toMatch(/^invalid_token:/);
  });

  it("returns 403 on provider mismatch", async () => {
    const { jwt } = await mintToken({
      provider: "openai",
      scopes: ["*"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/hello`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("provider_mismatch");
  });

  it("returns 403 on scope deny", async () => {
    const { jwt } = await mintToken({
      scopes: ["GET:/v1/onlyget"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/something/else`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("scope_denied");
  });

  it("regression — denies the boundary attack at the proxy layer", async () => {
    // Pinned: scope `POST:/v1/foo` MUST NOT match `/v1/foobar`.
    const { jwt } = await mintToken({
      scopes: ["POST:/v1/foo"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/foobar`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("scope_denied");
  });

  it("returns 404 for an unknown provider", async () => {
    const { jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/notreal/v1/anything`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await jsonError(res)).toBe("unknown_provider");
  });
});

describe("proxy: quota enforcement", () => {
  it("third call returns 429 after a 2-call budget", async () => {
    const { jwt } = await mintToken({
      scopes: ["*"],
      maxCalls: 2,
    });
    const call = () =>
      fetch(`${brokerOrigin}/echo/v1/q`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    const r1 = await call();
    const r2 = await call();
    const r3 = await call();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
    expect(await jsonError(r3)).toBe("exhausted");
  });
});

describe("proxy: model allow-list (Phase 2.1)", () => {
  it("allows a request whose body.model is in mdl", async () => {
    const { jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
    });
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

  it("denies 403 model_not_allowed when body.model is not in mdl, recording attempted model in requestedModel column", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4-turbo", messages: [] }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_not_allowed");
    // Acceptance: the audit log records the attempted model in a structured
    // column, not encoded into the reason string.
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const denial = recent.find((e) => e.outcome === "denied" && e.reason === "model_not_allowed");
    expect(denial).toBeDefined();
    expect(denial?.requestedModel).toBe("gpt-4-turbo");
  });

  it("does not consume a quota slot when the request is denied for model", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
      maxCalls: 1,
    });
    // First call: a denied model should NOT use up the only quota slot.
    const r1 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4-turbo", messages: [] }),
    });
    expect(r1.status).toBe(403);
    // Second call with the allowed model should succeed.
    const r2 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    });
    expect(r2.status).toBe(200);
    // And quota is now exhausted.
    const tokenRow = store.listTokens().find((t) => t.id === id);
    expect(tokenRow?.remaining).toBe(0);
  });

  it("token without mdl claim accepts any model (no restriction)", async () => {
    const { jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "literally-anything", messages: [] }),
    });
    expect(res.status).toBe(200);
  });

  it("denies a mdl-restricted POST with a body that has no model field (no-model is suspicious)", async () => {
    // Behavior-flip from the original "permissive on undefined" semantics:
    // a model-restricted token cannot reach a POST endpoint without
    // declaring a model. The broker enforces this rather than depending
    // on upstream strictness as the security boundary.
    const { jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/something`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [] }), // no model field
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_not_allowed");
  });

  it("denies a mdl-restricted POST when the body fails to parse as JSON", async () => {
    // Closes the bypass where a stolen token sends malformed JSON to skip
    // the model check. Send raw text under application/json so Fastify
    // forwards it to our extractor as-is.
    const { jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/something`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "text/plain",
      },
      body: "this is not json at all",
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("model_not_allowed");
  });

  it("allows a mdl-restricted GET (no body, no model invocable)", async () => {
    // GET/HEAD requests cannot invoke a model — the broker's restriction is
    // about what the token can CALL, not what endpoints it can browse. So
    // a model-restricted token can still GET listing/health endpoints.
    const { jwt } = await mintToken({
      scopes: ["*"],
      models: ["gpt-4o-mini"],
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("proxy: token presentation styles", () => {
  it("accepts the raw brk_ token in Authorization (no Bearer prefix)", async () => {
    const { jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        Authorization: jwt,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });

  it("accepts brk_ token in x-api-key header", async () => {
    const { jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/x`, {
      method: "POST",
      headers: {
        "x-api-key": jwt,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
  });
});
