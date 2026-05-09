import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const WORKER = resolve(HERE, "fixtures", "consume-worker.ts");

function spawnWorker(dbPath: string, tokenId: string): Promise<string> {
  return new Promise((resolveOut, reject) => {
    // shell:true on Windows so .cmd resolves; harmless on POSIX.
    const child = spawn(TSX, [WORKER, dbPath, tokenId], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`worker exited ${code}: ${err}`));
      } else {
        resolveOut(out.trim());
      }
    });
  });
}

function token(id: string, remaining: number): TokenRecord {
  return {
    id,
    provider: "echo",
    scopes: ["*"],
    remaining,
    used: 0,
    expiresAt: 0,
    createdAt: new Date().toISOString(),
    label: "concurrent-test",
    revoked: false,
  };
}

describe("SqliteStore: cross-process atomicity", () => {
  // The roadmap's Phase 1.2 acceptance test:
  // > two concurrent tsx processes hammering the same broker with --max-calls 1
  // > tokens never both succeed
  //
  // We spawn N real child processes (each its own SQLite connection) and
  // verify exactly one wins per max-calls=1 token. tsx startup dominates
  // wall time; this test runs in ~5–8s.
  it("only one of N concurrent processes wins a max-calls=1 token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-concurrent-"));
    const dbPath = join(dir, "store.db");
    try {
      // Seed the token.
      const seed = new SqliteStore(dbPath);
      seed.putToken(token("solo", 1));
      seed.close();

      const N = 5;
      const outputs = await Promise.all(
        Array.from({ length: N }, () => spawnWorker(dbPath, "solo")),
      );

      const wins = outputs.filter((o) => o === "ok").length;
      const exhausted = outputs.filter((o) => o === "exhausted").length;
      expect(wins).toBe(1);
      expect(exhausted).toBe(N - 1);

      // Final state: used=1, remaining=0.
      const verify = new SqliteStore(dbPath);
      const t = verify.getToken("solo");
      verify.close();
      expect(t?.used).toBe(1);
      expect(t?.remaining).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("across many tokens, total wins equals total budget (no double-counting)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-concurrent-multi-"));
    const dbPath = join(dir, "store.db");
    try {
      const seed = new SqliteStore(dbPath);
      const ids = Array.from({ length: 6 }, (_, i) => `tok-${i}`);
      // 4 tokens with budget 1, 2 tokens with budget 2 → total 8 wins available.
      for (const [i, id] of ids.entries()) {
        seed.putToken(token(id, i < 4 ? 1 : 2));
      }
      seed.close();

      // Two workers per token — for budget-1 tokens at most 1 wins;
      // for budget-2 tokens both should win. Total expected wins: 4*1 + 2*2 = 8.
      const jobs: Array<Promise<string>> = [];
      for (const id of ids) {
        jobs.push(spawnWorker(dbPath, id));
        jobs.push(spawnWorker(dbPath, id));
      }
      const outputs = await Promise.all(jobs);

      const totalWins = outputs.filter((o) => o === "ok").length;
      expect(totalWins).toBe(8);

      // Verify per-token state.
      const verify = new SqliteStore(dbPath);
      for (const [i, id] of ids.entries()) {
        const t = verify.getToken(id);
        const initial = i < 4 ? 1 : 2;
        expect(t?.used).toBe(initial);
        expect(t?.remaining).toBe(0);
      }
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
