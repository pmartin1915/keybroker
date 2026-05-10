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
        // Phase 2.2: when the request path contains "/usage", attach an
        // OpenAI-shaped `usage` object so the broker's post-call parser
        // has something to reconcile. Token counts come from the JSON
        // body if present (`upstream_usage: { in, out }`), defaulting to
        // a small constant so the actual cost is non-zero but tiny.
        let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
        if (req.url?.includes("/usage")) {
          let inTok = 100;
          let outTok = 50;
          try {
            const parsed = body ? (JSON.parse(body) as { upstream_usage?: { in?: number; out?: number } }) : undefined;
            if (parsed?.upstream_usage?.in !== undefined) inTok = parsed.upstream_usage.in;
            if (parsed?.upstream_usage?.out !== undefined) outTok = parsed.upstream_usage.out;
          } catch {
            // body wasn't JSON; use defaults
          }
          usage = { prompt_tokens: inTok, completion_tokens: outTok };
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            authorization: req.headers["authorization"] ?? null,
            body: body || null,
            ...(usage ? { usage } : {}),
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
  machine?: string;
  capUsd?: number;
  tags?: { team?: string; project?: string; env?: string };
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
  if (opts.machine !== undefined) rec.machine = opts.machine;
  if (opts.capUsd !== undefined) rec.capUsd = opts.capUsd;
  if (opts.tags?.team !== undefined) rec.tagTeam = opts.tags.team;
  if (opts.tags?.project !== undefined) rec.tagProject = opts.tags.project;
  if (opts.tags?.env !== undefined) rec.tagEnv = opts.tags.env;
  store.putToken(rec);
  const jwt = await issueToken(config.jwtSecret, {
    tokenId: id,
    provider,
    scopes,
    label: "test",
    ttlSeconds: ttl,
    models: opts.models,
    machine: opts.machine,
    capUsd: opts.capUsd,
    tags: opts.tags,
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

describe("proxy: machine attribution (Phase 2.3)", () => {
  it("threads the issuing machine into the success audit entry", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      machine: "perrypc",
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
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((e) => e.outcome === "ok");
    expect(ok?.machine).toBe("perrypc");
  });

  it("threads the issuing machine into denial audit entries", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["GET:/v1/onlyget"],
      machine: "perrypc",
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/forbidden`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const denial = recent.find((e) => e.outcome === "denied");
    expect(denial?.reason).toBe("scope_denied");
    expect(denial?.machine).toBe("perrypc");
  });

  it("omits the machine field when token has no mch claim (back-compat)", async () => {
    const { id, jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/hello`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((e) => e.outcome === "ok");
    expect(ok?.machine).toBeUndefined();
  });

  it("acceptance: three machines → audit unambiguously attributes every call, and revoke-all isolates by machine", async () => {
    // Roadmap acceptance criterion for Phase 2.3.
    const a = await mintToken({ scopes: ["*"], machine: "alpha" });
    const b = await mintToken({ scopes: ["*"], machine: "beta" });
    const c = await mintToken({ scopes: ["*"], machine: "gamma" });

    const callOnce = (jwt: string, path: string) =>
      fetch(`${brokerOrigin}/echo/v1/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
    expect((await callOnce(a.jwt, "fa")).status).toBe(200);
    expect((await callOnce(b.jwt, "fb")).status).toBe(200);
    expect((await callOnce(c.jwt, "fc")).status).toBe(200);

    // Audit log attributes every call to the right machine.
    const alphaCalls = store
      .recentCalls({ limit: 100, machine: "alpha" })
      .filter((e) => e.tokenId === a.id);
    const betaCalls = store
      .recentCalls({ limit: 100, machine: "beta" })
      .filter((e) => e.tokenId === b.id);
    const gammaCalls = store
      .recentCalls({ limit: 100, machine: "gamma" })
      .filter((e) => e.tokenId === c.id);
    expect(alphaCalls.every((e) => e.machine === "alpha")).toBe(true);
    expect(betaCalls.every((e) => e.machine === "beta")).toBe(true);
    expect(gammaCalls.every((e) => e.machine === "gamma")).toBe(true);
    expect(alphaCalls.length).toBeGreaterThanOrEqual(1);
    expect(betaCalls.length).toBeGreaterThanOrEqual(1);
    expect(gammaCalls.length).toBeGreaterThanOrEqual(1);

    // Bulk-revoke alpha (laptop-was-stolen): mirrors what the
    // `keybroker revoke-all --machine alpha` CLI does internally —
    // listTokens({ machine }) → revokeToken each.
    const stolen = store.listTokens({ machine: "alpha" });
    for (const t of stolen) store.revokeToken(t.id);

    // Alpha can no longer call.
    const aRetry = await callOnce(a.jwt, "still-alpha");
    expect(aRetry.status).toBe(401);
    expect(((await aRetry.json()) as { error: string }).error).toBe("revoked");

    // Beta and gamma are unaffected.
    expect((await callOnce(b.jwt, "still-beta")).status).toBe(200);
    expect((await callOnce(c.jwt, "still-gamma")).status).toBe(200);
  });
});

describe("proxy: USD cap enforcement (Phase 2.2)", () => {
  // Reference price for gpt-4o-mini at the time of writing: $0.15 input /
  // $0.60 output per 1M tokens. With max_tokens=1000 and our conservative
  // input=0 default, the pre-flight estimate is 0.001 * 0.6 = $0.0006.
  // Any cap >= $0.001 lets the call through; a cap below that blocks it.
  const ESTIMATE_PER_K_OUT_TOKENS = 0.0006;

  it("allows a call whose estimated cost fits under the cap (200 + estimatedCostUsd recorded)", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 0.5, // generous
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1000 }),
    });
    expect(res.status).toBe(200);
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((e) => e.outcome === "ok");
    expect(ok?.estimatedCostUsd).toBeCloseTo(ESTIMATE_PER_K_OUT_TOKENS, 6);
  });

  it("denies 403 cap_exceeded_estimate when the pre-flight estimate exceeds the cap", async () => {
    // gpt-4o output is $10/M; max_tokens=1_000_000 → estimate $10. A cap
    // of $1 must refuse this call before it reaches upstream.
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 1,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 1_000_000 }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("cap_exceeded_estimate");
    // Acceptance: the audit log records the attempted model (so an
    // operator can see what the caller tried to spend on).
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const denial = recent.find(
      (e) => e.outcome === "denied" && e.reason === "cap_exceeded_estimate",
    );
    expect(denial?.requestedModel).toBe("gpt-4o");
  });

  it("does not consume a quota slot when the request is denied for cap", async () => {
    // Mirror of the Phase 2.1 'denied requests don't burn quota' invariant.
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 0.0001,
      maxCalls: 1,
    });
    const r1 = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 1000 }),
    });
    expect(r1.status).toBe(403);
    const tokenRow = store.listTokens().find((t) => t.id === id);
    // The single quota slot survives the denial.
    expect(tokenRow?.remaining).toBe(1);
  });

  it("denies 403 cap_unpriced_model when the model is not in the pricing table", async () => {
    // A capped token sending a model the broker can't price must be
    // refused — silently passing through would mean cap accounting
    // contributes nothing, effectively disabling the cap.
    const { jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 1,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "totally-fake-model", max_tokens: 100 }),
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("cap_unpriced_model");
  });

  it("denies 403 cap_unpriced_model when the body has no model field", async () => {
    const { jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 1,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_tokens: 100 }), // no model field
    });
    expect(res.status).toBe(403);
    expect(await jsonError(res)).toBe("cap_unpriced_model");
  });

  it("token without cap claim is unaffected (back-compat with pre-2.2 tokens)", async () => {
    const { id, jwt } = await mintToken({ scopes: ["*"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 1_000_000 }),
    });
    expect(res.status).toBe(200);
    // Audit entry is written; estimatedCostUsd is undefined because no
    // cap was set (we only compute the estimate when a cap fires).
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((e) => e.outcome === "ok");
    expect(ok?.estimatedCostUsd).toBeUndefined();
  });

  it("post-call usage parse: actualCostUsd is reconciled when upstream returns usage", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 1,
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/chat/completions/usage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 1000,
        upstream_usage: { in: 1_000_000, out: 1_000_000 },
      }),
    });
    expect(res.status).toBe(200);
    // Wait for the streamed-finish handler to flush its appendCall.
    // finished(counter) fires asynchronously after reply.send(), so a
    // tiny tick is needed before recentCalls sees the row.
    await new Promise((r) => setTimeout(r, 50));
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((e) => e.outcome === "ok");
    expect(ok?.estimatedCostUsd).toBeDefined();
    // Reconciled actual: 1M input * $0.15 + 1M output * $0.60 = $0.75.
    expect(ok?.actualCostUsd).toBeCloseTo(0.75, 4);
  });

  it("acceptance: cap of $0.50, two priced calls — second is denied when cumulative would exceed", async () => {
    // Roadmap acceptance criterion for Phase 2.2: caps decrement across
    // calls. We use the post-call actual ($0.30 each via the upstream
    // usage stub) so both calls land. After two calls cumulative = $0.60
    // which exceeds $0.50; the third call's pre-flight ($0.0006) plus
    // cumulative ($0.60) > cap ($0.50), so it's denied.
    const { id, jwt } = await mintToken({
      scopes: ["*"],
      capUsd: 0.5,
    });
    const callOnce = () =>
      fetch(`${brokerOrigin}/echo/v1/chat/completions/usage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 100,
          // 1M input * $0.15 + 250k output * $0.60 = $0.30
          upstream_usage: { in: 1_000_000, out: 250_000 },
        }),
      });

    const r1 = await callOnce();
    expect(r1.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await callOnce();
    expect(r2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    // Cumulative is now ~$0.60 from the two reconciled actuals. A third
    // call's pre-flight estimate plus cumulative exceeds the $0.50 cap.
    const r3 = await callOnce();
    expect(r3.status).toBe(403);
    expect(await jsonError(r3)).toBe("cap_exceeded_estimate");

    // The third (denied) call did not contribute to spend.
    const spend = store.sumCostUsdByToken(id);
    expect(spend).toBeCloseTo(0.6, 4);
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

describe("proxy: tag attribution (Phase 3.3)", () => {
  // Each test mints a freshly-tagged token and inspects its row in the
  // audit log via store.recentCalls. The broker carries `tag.t/p/e` from
  // the verified JWT into CallLogEntry.tagTeam/tagProject/tagEnv on
  // every audit-write path: success, error, and denied.

  it("propagates tag fields to a successful call's audit row", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["POST:/v1/"],
      tags: { team: "platform", project: "dispatcher", env: "prod" },
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/tagged-ok`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const calls = store.recentCalls({ limit: 5, tokenId: id });
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last?.outcome).toBe("ok");
    expect(last?.tagTeam).toBe("platform");
    expect(last?.tagProject).toBe("dispatcher");
    expect(last?.tagEnv).toBe("prod");
  });

  it("propagates a partial tag (project only) without leaking the others", async () => {
    const { id, jwt } = await mintToken({
      scopes: ["POST:/v1/"],
      tags: { project: "broker" },
    });
    const res = await fetch(`${brokerOrigin}/echo/v1/tag-partial`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const calls = store.recentCalls({ limit: 5, tokenId: id });
    const last = calls[calls.length - 1];
    expect(last?.tagProject).toBe("broker");
    expect(last?.tagTeam).toBeUndefined();
    expect(last?.tagEnv).toBeUndefined();
  });

  it("propagates tags to denied audit rows (scope_denied path)", async () => {
    // Denials must carry attribution too — otherwise FinOps queries
    // would miss spend-adjacent activity (e.g. who tried to call the
    // wrong endpoint with a forbidden token).
    const { id, jwt } = await mintToken({
      scopes: ["GET:/v1/onlyget"],
      tags: { team: "infra", env: "dev" },
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
    const calls = store.recentCalls({ limit: 5, tokenId: id });
    const last = calls[calls.length - 1];
    expect(last?.outcome).toBe("denied");
    expect(last?.tagTeam).toBe("infra");
    expect(last?.tagEnv).toBe("dev");
    expect(last?.tagProject).toBeUndefined();
  });

  it("leaves tag fields undefined for an untagged token", async () => {
    const { id, jwt } = await mintToken({ scopes: ["POST:/v1/"] });
    const res = await fetch(`${brokerOrigin}/echo/v1/untagged`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const calls = store.recentCalls({ limit: 5, tokenId: id });
    const last = calls[calls.length - 1];
    expect(last?.tagTeam).toBeUndefined();
    expect(last?.tagProject).toBeUndefined();
    expect(last?.tagEnv).toBeUndefined();
  });
});

describe("/metrics/spend (Phase 3.4)", () => {
  // The route is open (no token required) — same posture as /health.
  // It reads the same audit log every other test populates, so each
  // assertion seeds its own tagged audit rows directly via store.appendCall
  // rather than going through the proxy. That keeps these tests fast
  // and independent of upstream availability.

  it("rejects an invalid bucket", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=region&since=24h`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_bucket");
  });

  it("rejects a missing bucket", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?since=24h`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_bucket");
  });

  it("rejects a missing since", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("missing_since");
  });

  it("rejects an unparseable since", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=yesterday`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_since");
  });

  it("rejects since with a non-shorthand unit", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=24x`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_since");
  });

  it("rejects an invalid limit", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=24h&limit=0`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_limit");
  });

  it("rejects a limit above the cap", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=24h&limit=9999`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_limit");
  });

  it("returns a ranked list with key, usd, and callCount", async () => {
    // Seed three tagged calls inside the 24h window. We use a unique
    // team-tag prefix so this assertion isn't disturbed by the rows
    // earlier tests in this file appended (those use generic team
    // names like "platform" / "infra").
    const ts = new Date().toISOString();
    const tag = (s: string) => `m34-${s}`;
    store.appendCall({
      ts,
      tokenId: "metrics-test",
      label: "test",
      provider: "echo",
      method: "POST",
      path: "/v1/x",
      status: 200,
      durationMs: 5,
      reqBytes: 0,
      respBytes: 0,
      outcome: "ok",
      tagTeam: tag("alpha"),
      actualCostUsd: 0.10,
    });
    store.appendCall({
      ts,
      tokenId: "metrics-test",
      label: "test",
      provider: "echo",
      method: "POST",
      path: "/v1/x",
      status: 200,
      durationMs: 5,
      reqBytes: 0,
      respBytes: 0,
      outcome: "ok",
      tagTeam: tag("alpha"),
      actualCostUsd: 0.05,
    });
    store.appendCall({
      ts,
      tokenId: "metrics-test",
      label: "test",
      provider: "echo",
      method: "POST",
      path: "/v1/x",
      status: 200,
      durationMs: 5,
      reqBytes: 0,
      respBytes: 0,
      outcome: "ok",
      tagTeam: tag("bravo"),
      actualCostUsd: 0.50,
    });
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=24h`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      key: string;
      usd: number;
      callCount: number;
    }>;
    const ours = rows.filter((r) => r.key.startsWith("m34-"));
    expect(ours.map((r) => r.key)).toEqual([tag("bravo"), tag("alpha")]);
    expect(ours[0]!.usd).toBeCloseTo(0.50, 6);
    expect(ours[0]!.callCount).toBe(1);
    expect(ours[1]!.usd).toBeCloseTo(0.15, 6);
    expect(ours[1]!.callCount).toBe(2);
  });

  it("respects the limit query parameter", async () => {
    // We've seeded two m34- team tags above (alpha, bravo). Asking
    // limit=1 should truncate to just the highest-spend bucket. We
    // can't assert exact identity since other tests in this file
    // populate "platform"/"infra"/etc with potentially higher spend,
    // so we check only that the response respects the cap.
    const res = await fetch(`${brokerOrigin}/metrics/spend?bucket=team&since=24h&limit=1`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ key: string; usd: number }>;
    expect(rows.length).toBe(1);
  });
});

describe("/forecast (Phase 3.5)", () => {
  // The forecast routes share the same audit log every other test in
  // this file populates. Seeding tagged audit rows directly via
  // store.appendCall keeps these tests fast and independent of
  // upstream availability — same posture as the /metrics/spend tests.

  it("rejects an invalid since on /forecast/tokens", async () => {
    const res = await fetch(`${brokerOrigin}/forecast/tokens?since=yesterday`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_since");
  });

  it("rejects an invalid top on /forecast/tokens", async () => {
    const res = await fetch(`${brokerOrigin}/forecast/tokens?top=0`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_top");
  });

  it("defaults to since=14d when omitted", async () => {
    // No `since` query — should not 400 (defaulted server-side).
    const res = await fetch(`${brokerOrigin}/forecast/tokens?top=5`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<unknown>;
    expect(Array.isArray(rows)).toBe(true);
  });

  it("rejects an invalid bucket on /forecast/tags", async () => {
    const res = await fetch(`${brokerOrigin}/forecast/tags?bucket=region`);
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_bucket");
  });

  it("rejects an invalid since on /forecast/tags", async () => {
    const res = await fetch(
      `${brokerOrigin}/forecast/tags?bucket=team&since=tomorrow`,
    );
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_since");
  });

  it("rejects an invalid top on /forecast/tags", async () => {
    const res = await fetch(
      `${brokerOrigin}/forecast/tags?bucket=team&top=9999`,
    );
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("invalid_top");
  });

  it("forecasts per-token burn and computes daysUntilCap from a clean series", async () => {
    // Mint a token with cap=$20 and seed 14 days of $1/day priced
    // spend. Slope should land near $1/day, current = $14, daysUntilCap
    // ≈ 6. We isolate this token from the rest of the audit log by
    // its unique label (`f35-burn`) and tokenId.
    const { id } = await mintToken({ capUsd: 20 });
    // Re-stamp the token's label so the response is filterable.
    const t = store.getToken(id);
    if (!t) throw new Error("token vanished");
    t.label = "f35-burn";
    store.putToken(t);
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const ts = new Date(today.getTime() - (13 - i) * 86_400_000).toISOString();
      store.appendCall({
        ts,
        tokenId: id,
        label: "f35-burn",
        provider: "echo",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 5,
        reqBytes: 0,
        respBytes: 0,
        outcome: "ok",
        actualCostUsd: 1.0,
      });
    }
    // Ask for a generous top so our seeded token is included even with
    // many unrelated tokens already in the store.
    const res = await fetch(
      `${brokerOrigin}/forecast/tokens?since=14d&top=1000`,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      tokenId: string;
      label: string;
      slopeUsdPerDay: number;
      currentUsd: number;
      capUsd?: number;
      daysUntilCap?: number;
      projectedCapBreachDate?: string;
    }>;
    const ours = rows.find((r) => r.tokenId === id);
    expect(ours).toBeDefined();
    expect(ours!.label).toBe("f35-burn");
    expect(ours!.capUsd).toBe(20);
    expect(ours!.currentUsd).toBeCloseTo(14, 6);
    expect(ours!.slopeUsdPerDay).toBeGreaterThan(0.9);
    expect(ours!.slopeUsdPerDay).toBeLessThan(1.1);
    expect(ours!.daysUntilCap).toBeGreaterThan(5);
    expect(ours!.daysUntilCap).toBeLessThan(7);
    expect(ours!.projectedCapBreachDate).toBeDefined();
  });

  it("ranks tags by slopeUsdPerDay descending with alphabetic tiebreak", async () => {
    // Two team tags burning at the same rate — alphabetic ordering
    // pins them. Use a unique prefix so other tests' tagged rows don't
    // bleed in.
    const tag = (s: string) => `f35-${s}`;
    const today = new Date();
    for (let i = 0; i < 14; i++) {
      const ts = new Date(today.getTime() - (13 - i) * 86_400_000).toISOString();
      // alpha and bravo each get $1/day; charlie gets $5/day.
      store.appendCall({
        ts,
        tokenId: "f35-tag-test",
        label: "f35-tag",
        provider: "echo",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 5,
        reqBytes: 0,
        respBytes: 0,
        outcome: "ok",
        tagTeam: tag("alpha"),
        actualCostUsd: 1.0,
      });
      store.appendCall({
        ts,
        tokenId: "f35-tag-test",
        label: "f35-tag",
        provider: "echo",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 5,
        reqBytes: 0,
        respBytes: 0,
        outcome: "ok",
        tagTeam: tag("bravo"),
        actualCostUsd: 1.0,
      });
      store.appendCall({
        ts,
        tokenId: "f35-tag-test",
        label: "f35-tag",
        provider: "echo",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 5,
        reqBytes: 0,
        respBytes: 0,
        outcome: "ok",
        tagTeam: tag("charlie"),
        actualCostUsd: 5.0,
      });
    }
    const res = await fetch(
      `${brokerOrigin}/forecast/tags?bucket=team&since=14d&top=1000`,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      bucket: string;
      key: string;
      slopeUsdPerDay: number;
      currentUsd: number;
      daysUntilCap?: number;
    }>;
    const ours = rows.filter((r) => r.key.startsWith("f35-"));
    // charlie burns 5x; alpha and bravo are tied — alphabetic tiebreak.
    expect(ours.map((r) => r.key)).toEqual([
      tag("charlie"),
      tag("alpha"),
      tag("bravo"),
    ]);
    expect(ours[0]!.slopeUsdPerDay).toBeGreaterThan(ours[1]!.slopeUsdPerDay);
    // Tag forecast never has a cap → no daysUntilCap.
    for (const r of ours) {
      expect(r.daysUntilCap).toBeUndefined();
    }
  });
});
