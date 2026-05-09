import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { BrokerConfig } from "../src/config.js";
import type { StoreLike, TokenRecord } from "../src/store.js";

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

const CHUNK_COUNT = 6;
const CHUNK_BODY = "data: token-N\n\n"; // 15 bytes per chunk
const CHUNK_GAP_MS = 30;

function makeStreamingUpstream(): Promise<{ server: Server; port: number }> {
  return new Promise((resolveOut) => {
    const s = createServer((req, res) => {
      // /stream/<n> emits N chunks of CHUNK_BODY with CHUNK_GAP_MS gaps,
      // SSE-style: one shot of headers, then incremental writes.
      if (req.url?.startsWith("/stream/")) {
        const n = Number(req.url.slice("/stream/".length)) || CHUNK_COUNT;
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        let i = 0;
        const tick = () => {
          if (i >= n) {
            res.end();
            return;
          }
          res.write(CHUNK_BODY.replace("N", String(i)));
          i += 1;
          setTimeout(tick, CHUNK_GAP_MS);
        };
        tick();
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

async function mintToken(scopes: string[] = ["*"]): Promise<string> {
  const id = newTokenId();
  const rec: TokenRecord = {
    id,
    provider: "echo",
    scopes,
    remaining: -1,
    used: 0,
    expiresAt: 0,
    createdAt: new Date().toISOString(),
    label: "stream-test",
    revoked: false,
  };
  store.putToken(rec);
  return await issueToken(config.jwtSecret, {
    tokenId: id,
    provider: "echo",
    scopes,
    label: "stream-test",
    ttlSeconds: 600,
  });
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

  dataDir = mkdtempSync(join(tmpdir(), "kb-stream-test-"));
  const masterKeyHex = generateMasterKeyHex();
  const jwtSecret = generateJwtSecret();
  config = {
    dataDir,
    jsonStorePath: join(dataDir, "store.json"),
    sqliteStorePath: join(dataDir, "store.db"),
    logsPath: join(dataDir, "calls.log.jsonl"),
    configPath: join(dataDir, "config.json"),
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

describe("proxy: streaming pass-through", () => {
  it("delivers chunks incrementally, not buffered", async () => {
    const jwt = await mintToken();
    const res = await fetch(`${brokerOrigin}/echo/stream/${CHUNK_COUNT}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    if (!res.body) throw new Error("no response body");

    // Read chunks with timestamps. If the broker buffered, all chunks would
    // arrive at roughly the same instant (after the upstream finished, ~180ms).
    // Streaming means we should see at least 3 chunks at >CHUNK_GAP_MS/2 apart.
    const reader = res.body.getReader();
    const chunkArrivals: number[] = [];
    const start = Date.now();
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkArrivals.push(Date.now() - start);
      totalBytes += value.byteLength;
    }

    expect(totalBytes).toBe(CHUNK_BODY.length * CHUNK_COUNT);
    // We expect multiple distinct arrival times. node's network buffering may
    // coalesce some chunks, so we don't require CHUNK_COUNT — just enough
    // separation that buffering is clearly off.
    expect(chunkArrivals.length).toBeGreaterThanOrEqual(2);
    const span = chunkArrivals[chunkArrivals.length - 1]! - chunkArrivals[0]!;
    expect(span).toBeGreaterThanOrEqual(CHUNK_GAP_MS);
  }, 15_000);

  it("audit log records exact respBytes after the stream closes", async () => {
    const jwt = await mintToken();
    // Wait for any prior in-flight log writes to settle before we read.
    const res = await fetch(`${brokerOrigin}/echo/stream/${CHUNK_COUNT}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    // Drain.
    await res.arrayBuffer();
    // The audit write happens on stream finish, which is after the client
    // sees `done`. Give it a tick.
    await new Promise((r) => setTimeout(r, 100));

    const calls = store.recentCalls({ limit: 50 });
    // Find the call whose path matches the stream URL.
    const ours = calls.find(
      (c) => c.path === `/stream/${CHUNK_COUNT}` && c.outcome === "ok",
    );
    expect(ours).toBeDefined();
    expect(ours!.respBytes).toBe(CHUNK_BODY.length * CHUNK_COUNT);
    expect(ours!.status).toBe(200);
  }, 15_000);
});
