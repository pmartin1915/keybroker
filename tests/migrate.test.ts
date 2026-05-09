import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "../src/store-json.js";
import { SqliteStore } from "../src/store-sqlite.js";
import type { TokenRecord } from "../src/store-types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(
  REPO,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const CLI = resolve(REPO, "src", "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveOut, reject) => {
    const child = spawn(TSX, [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveOut({ code: code ?? -1, stdout, stderr }),
    );
  });
}

function tokenRec(id: string, remaining: number): TokenRecord {
  return {
    id,
    provider: "echo",
    scopes: ["POST:/v1/"],
    remaining,
    used: 0,
    expiresAt: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    label: `tok-${id}`,
    revoked: false,
  };
}

describe("keybroker migrate", () => {
  it("copies secrets, tokens, and call log from JSON to SQLite, then renames JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-migrate-"));
    try {
      // 1. Init the broker (creates config.json with master key + jwt secret).
      const init = await runCli(["init"], { KEYBROKER_HOME: home });
      expect(init.code).toBe(0);

      // 2. Seed a JSON store directly with secrets, tokens, and a few calls.
      const json = new JsonStore(
        join(home, "store.json"),
        join(home, "calls.log.jsonl"),
      );
      json.putSecret("echo", {
        provider: "echo",
        ciphertext: "ct-echo",
        createdAt: "t-secret",
      });
      json.putSecret("openai", {
        provider: "openai",
        ciphertext: "ct-oa",
        createdAt: "t-secret-2",
      });
      json.putToken(tokenRec("t1", 5));
      json.putToken(tokenRec("t2", 1));
      json.appendCall({
        ts: "2026-01-01T00:00:00.000Z",
        tokenId: "t1",
        label: "tok-t1",
        provider: "echo",
        method: "POST",
        path: "/v1/x",
        status: 200,
        durationMs: 10,
        reqBytes: 0,
        respBytes: 5,
        outcome: "ok",
      });
      json.appendCall({
        ts: "2026-01-01T00:00:01.000Z",
        tokenId: "t2",
        label: "tok-t2",
        provider: "echo",
        method: "POST",
        path: "/v1/y",
        status: 403,
        durationMs: 2,
        reqBytes: 0,
        respBytes: 0,
        outcome: "denied",
        reason: "scope_denied",
      });

      // 3. Run migrate.
      const migrate = await runCli(["migrate"], { KEYBROKER_HOME: home });
      expect(migrate.code).toBe(0);
      expect(migrate.stdout).toMatch(/2 secrets, 2 tokens, 2 call log entries/);

      // 4. Verify SQLite state.
      expect(existsSync(join(home, "store.db"))).toBe(true);
      expect(existsSync(join(home, "store.json"))).toBe(false);
      expect(existsSync(join(home, "store.json.migrated"))).toBe(true);

      const sqlite = new SqliteStore(join(home, "store.db"));
      try {
        expect(sqlite.getSecret("echo")?.ciphertext).toBe("ct-echo");
        expect(sqlite.getSecret("openai")?.ciphertext).toBe("ct-oa");
        expect(sqlite.getToken("t1")?.remaining).toBe(5);
        expect(sqlite.getToken("t2")?.remaining).toBe(1);
        const calls = sqlite.recentCalls({ limit: 100 });
        expect(calls.length).toBe(2);
        const denied = calls.find((c) => c.outcome === "denied");
        expect(denied?.reason).toBe("scope_denied");
      } finally {
        sqlite.close();
      }

      // 5. A second migrate should refuse (sqlite db now exists).
      const second = await runCli(["migrate"], { KEYBROKER_HOME: home });
      expect(second.code).not.toBe(0);
      expect(second.stderr).toMatch(/already exists/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("--dry-run does not write the SQLite db or rename the JSON file", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-migrate-dry-"));
    try {
      const init = await runCli(["init"], { KEYBROKER_HOME: home });
      expect(init.code).toBe(0);

      const json = new JsonStore(
        join(home, "store.json"),
        join(home, "calls.log.jsonl"),
      );
      json.putToken(tokenRec("only", 3));

      const dry = await runCli(["migrate", "--dry-run"], {
        KEYBROKER_HOME: home,
      });
      expect(dry.code).toBe(0);
      expect(dry.stdout).toMatch(/dry-run/);
      expect(existsSync(join(home, "store.db"))).toBe(false);
      expect(existsSync(join(home, "store.json"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
