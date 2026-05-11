import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { SqliteStore } from "../src/store.js";
import { generateMasterKeyHex, generateJwtSecret } from "../src/crypto.js";
import type { BrokerConfig } from "../src/config.js";

// Phase 4.0: the broker mounts the bundled React control plane at /ui.
// These tests verify both branches of the mount logic — built (web/dist
// present) and not-built (fallback hint HTML) — and that the static
// mount does not shadow the provider proxy catch-all.

const here = dirname(fileURLToPath(import.meta.url));
const webDistIndex = pathResolve(here, "..", "web", "dist", "index.html");
const webDistBuilt = existsSync(webDistIndex);

let app: FastifyInstance;
let origin: string;
let dataDir: string;
let store: SqliteStore;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "keybroker-ui-"));
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

describe("/ui static mount", () => {
  it("serves HTML at /ui/", async () => {
    const res = await fetch(`${origin}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/html/);
    const body = await res.text();
    if (webDistBuilt) {
      // The Vite bundle's index.html mounts a #root and pulls a module
      // script — either marker is sufficient evidence of the real SPA.
      expect(body).toMatch(/<div id="root">|type="module"/);
    } else {
      expect(body).toContain("Keybroker UI not built");
    }
  });

  it("redirects /ui (no trailing slash) to /ui/", async () => {
    const res = await fetch(`${origin}/ui`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui/");
  });

  it("does not shadow the provider proxy catch-all", async () => {
    // Hitting an unknown provider should still produce the broker's
    // structured `unknown_provider` denial — /ui/ must not capture it.
    const res = await fetch(`${origin}/nope-not-a-provider/v1/anything`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unknown_provider");
  });
});
