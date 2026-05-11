import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { BrokerConfig } from "../src/config.js";
import type { StoreLike, TokenRecord } from "../src/store.js";
import { computeLatencyStats } from "../src/latency-stats.js";

let buildServer: typeof import("../src/server.js").buildServer;
let SqliteStore: typeof import("../src/store.js").SqliteStore;
let newTokenId: typeof import("../src/store.js").newTokenId;
let issueToken: typeof import("../src/tokens.js").issueToken;
let encrypt: typeof import("../src/crypto.js").encrypt;
let generateMasterKeyHex: typeof import("../src/crypto.js").generateMasterKeyHex;
let generateJwtSecret: typeof import("../src/crypto.js").generateJwtSecret;

let upstream: Server;
let app: FastifyInstance;
let brokerOrigin: string;
let config: BrokerConfig;
let store: StoreLike;
let dataDir: string;

const PREFILL_MS = 80;
const CHUNK_GAP_MS = 40;
const OUTPUT_TOKENS = 6;

// Upstream that simulates an OpenAI-style streaming completion:
//   - Sends response headers immediately.
//   - Waits PREFILL_MS before the first chunk (TTFT).
//   - Then emits one `data: {…delta…}` per token, CHUNK_GAP_MS apart.
//   - Final `data: {…usage…}` event carries completion_tokens so the
//     broker can compute tpot_ms_avg.
function makeStreamingUpstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolveOut) => {
    const s = createServer((req, res) => {
      if (req.url?.startsWith("/stream")) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        // Flush headers immediately. Node sends them on first write,
        // but a write of empty space (or flushHeaders if available)
        // makes that timing explicit.
        if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
          (res as { flushHeaders: () => void }).flushHeaders();
        }
        let i = 0;
        const tick = () => {
          if (i >= OUTPUT_TOKENS) {
            // Final usage event mirrors OpenAI's
            // stream_options.include_usage payload shape.
            res.write(
              `data: ${JSON.stringify({
                choices: [],
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: OUTPUT_TOKENS,
                },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: `tok-${i}` } }],
            })}\n\n`,
          );
          i += 1;
          setTimeout(tick, CHUNK_GAP_MS);
        };
        setTimeout(tick, PREFILL_MS);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address() as AddressInfo;
      resolveOut({ server: s, port: addr.port });
    });
  });
}

async function mintToken(scopes: string[] = ["*"]): Promise<{ id: string; jwt: string }> {
  const id = newTokenId();
  const rec: TokenRecord = {
    id,
    provider: "echo",
    scopes,
    remaining: -1,
    used: 0,
    expiresAt: 0,
    createdAt: new Date().toISOString(),
    label: "latency-test",
    revoked: false,
  };
  store.putToken(rec);
  const jwt = await issueToken(config.jwtSecret, {
    tokenId: id,
    provider: "echo",
    scopes,
    label: "latency-test",
    ttlSeconds: 600,
  });
  return { id, jwt };
}

beforeAll(async () => {
  const u = await makeStreamingUpstream();
  upstream = u.server;
  process.env.KEYBROKER_ECHO_BASE_URL = `http://127.0.0.1:${u.port}`;

  ({ buildServer } = await import("../src/server.js"));
  ({ SqliteStore, newTokenId } = await import("../src/store.js"));
  ({ issueToken } = await import("../src/tokens.js"));
  ({ encrypt, generateMasterKeyHex, generateJwtSecret } = await import(
    "../src/crypto.js"
  ));

  dataDir = mkdtempSync(join(tmpdir(), "kb-latency-test-"));
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
    mgmtSecret: jwtSecret,
  };
  writeFileSync(
    config.configPath,
    JSON.stringify({ masterKeyHex, jwtSecret, port: 0, host: "127.0.0.1" }),
  );

  store = new SqliteStore(config.sqliteStorePath);
  store.putSecret("echo", {
    provider: "echo",
    ciphertext: encrypt("sk-fake", masterKeyHex),
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

describe("Phase 3.7 latency telemetry — audit row", () => {
  it("populates ttft_ms, tpot_ms_avg, output_tokens on a streamed completion", async () => {
    const { id, jwt } = await mintToken();
    const res = await fetch(`${brokerOrigin}/echo/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    // Drain the stream so the broker's `finished()` fires.
    await res.arrayBuffer();
    await new Promise((r) => setTimeout(r, 150));

    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const ok = recent.find((c) => c.outcome === "ok");
    expect(ok).toBeDefined();
    // TTFT should be at or above PREFILL_MS minus a generous slack for
    // localhost network jitter. We don't pin a tight upper bound — Node
    // can stall a tick or two under load.
    expect(ok!.ttftMs).toBeDefined();
    expect(ok!.ttftMs!).toBeGreaterThanOrEqual(PREFILL_MS - 30);
    expect(ok!.outputTokens).toBe(OUTPUT_TOKENS);
    expect(ok!.tpotMsAvg).toBeDefined();
    // (finish - firstByte) / OUTPUT_TOKENS. With CHUNK_GAP_MS=40 and
    // OUTPUT_TOKENS chunks, the streaming span is roughly
    // OUTPUT_TOKENS * CHUNK_GAP_MS. Per-token avg should land at least
    // half of CHUNK_GAP_MS, well below CHUNK_GAP_MS * 4.
    expect(ok!.tpotMsAvg!).toBeGreaterThan(CHUNK_GAP_MS / 4);
    expect(ok!.tpotMsAvg!).toBeLessThan(CHUNK_GAP_MS * 4);
  }, 15_000);

  it("leaves latency columns undefined on a denied call (no upstream egress)", async () => {
    // Scope deny — never reaches upstream, so no TTFT / TPOT.
    const { id, jwt } = await mintToken(["GET:/never-this-path"]);
    const res = await fetch(`${brokerOrigin}/echo/stream`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const recent = store.recentCalls({ limit: 5, tokenId: id });
    const denied = recent.find((c) => c.outcome === "denied");
    expect(denied).toBeDefined();
    expect(denied!.ttftMs).toBeUndefined();
    expect(denied!.tpotMsAvg).toBeUndefined();
    expect(denied!.outputTokens).toBeUndefined();
  });
});

describe("Phase 3.7 — /metrics/latency endpoint", () => {
  it("returns p50/p95 over recent calls for a token", async () => {
    const { id, jwt } = await mintToken();
    // Three streamed calls to build a small distribution.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${brokerOrigin}/echo/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      await res.arrayBuffer();
    }
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(
      `${brokerOrigin}/metrics/latency?token=${id}&since=1h`,
    );
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      sampleCount: number;
      p50TtftMs?: number;
      p95TtftMs?: number;
      p50TpotMsAvg?: number;
      p95TpotMsAvg?: number;
    };
    expect(stats.sampleCount).toBe(3);
    expect(stats.p50TtftMs).toBeDefined();
    expect(stats.p50TtftMs!).toBeGreaterThanOrEqual(PREFILL_MS - 30);
    expect(stats.p95TtftMs!).toBeGreaterThanOrEqual(stats.p50TtftMs!);
    expect(stats.p50TpotMsAvg).toBeDefined();
    expect(stats.p95TpotMsAvg!).toBeGreaterThanOrEqual(stats.p50TpotMsAvg!);
  }, 30_000);

  it("returns sampleCount:0 with undefined percentiles when no samples in window", async () => {
    const { id } = await mintToken();
    const res = await fetch(
      `${brokerOrigin}/metrics/latency?token=${id}&since=1s`,
    );
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      sampleCount: number;
      p50TtftMs?: number;
    };
    expect(stats.sampleCount).toBe(0);
    expect(stats.p50TtftMs).toBeUndefined();
  });

  it("400s on missing token", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/latency?since=1h`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_token");
  });

  it("400s on missing since", async () => {
    const res = await fetch(`${brokerOrigin}/metrics/latency?token=foo`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_since");
  });

  it("400s on invalid since shorthand", async () => {
    const res = await fetch(
      `${brokerOrigin}/metrics/latency?token=foo&since=garbage`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_since");
  });
});

describe("Phase 3.7 — computeLatencyStats (unit)", () => {
  it("returns sampleCount:0 with no percentiles for empty input", () => {
    const s = computeLatencyStats([], []);
    expect(s).toEqual({ sampleCount: 0 });
  });

  it("nearest-rank percentile on a known distribution", () => {
    // 10 samples 1..10; p50 = ceil(0.5*10)-1 = 4 → 5; p95 = ceil(0.95*10)-1 = 9 → 10.
    const ttfts = [10, 1, 7, 5, 3, 8, 2, 6, 4, 9];
    const tpots = [20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
    const s = computeLatencyStats(ttfts, tpots);
    expect(s.sampleCount).toBe(10);
    expect(s.p50TtftMs).toBe(5);
    expect(s.p95TtftMs).toBe(10);
    expect(s.p50TpotMsAvg).toBe(10);
    expect(s.p95TpotMsAvg).toBe(20);
  });

  it("partitions independent sample sizes (ttfts and tpots need not match)", () => {
    const ttfts = [100, 200, 300];
    const tpots = [50]; // Single TPOT sample — e.g., one call had no usage.
    const s = computeLatencyStats(ttfts, tpots);
    expect(s.sampleCount).toBe(3);
    expect(s.p50TtftMs).toBe(200);
    expect(s.p50TpotMsAvg).toBe(50);
    expect(s.p95TpotMsAvg).toBe(50);
  });

  it("single-sample array: p50 == p95 == only value", () => {
    const s = computeLatencyStats([42], [7]);
    expect(s.p50TtftMs).toBe(42);
    expect(s.p95TtftMs).toBe(42);
    expect(s.p50TpotMsAvg).toBe(7);
    expect(s.p95TpotMsAvg).toBe(7);
  });
});
