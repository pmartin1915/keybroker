import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "../src/store-json.js";
import { SqliteStore } from "../src/store-sqlite.js";
import type { StoreLike, TokenRecord } from "../src/store-types.js";
import type { CallLogEntry } from "../src/logging.js";

interface StoreFixture {
  store: StoreLike;
  cleanup: () => void;
}

const STORES: Array<{ name: string; make: () => StoreFixture }> = [
  {
    name: "JsonStore",
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), "kb-json-"));
      const store = new JsonStore(
        join(dir, "store.json"),
        join(dir, "calls.log.jsonl"),
      );
      return {
        store,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "SqliteStore",
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), "kb-sqlite-"));
      const store = new SqliteStore(join(dir, "store.db"));
      return {
        store,
        cleanup: () => {
          store.close?.();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

function tokenRec(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: overrides.id ?? "id-default",
    provider: overrides.provider ?? "echo",
    scopes: overrides.scopes ?? ["*"],
    remaining: overrides.remaining ?? -1,
    used: overrides.used ?? 0,
    expiresAt: overrides.expiresAt ?? 0,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    label: overrides.label ?? "test",
    revoked: overrides.revoked ?? false,
    ...(overrides.machine !== undefined ? { machine: overrides.machine } : {}),
    ...(overrides.capUsd !== undefined ? { capUsd: overrides.capUsd } : {}),
  };
}

function callRec(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    ts: overrides.ts ?? new Date().toISOString(),
    tokenId: overrides.tokenId ?? "id-default",
    label: overrides.label ?? "test",
    provider: overrides.provider ?? "echo",
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/v1/x",
    status: overrides.status ?? 200,
    durationMs: overrides.durationMs ?? 5,
    reqBytes: overrides.reqBytes ?? 0,
    respBytes: overrides.respBytes ?? 0,
    outcome: overrides.outcome ?? "ok",
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    ...(overrides.machine !== undefined ? { machine: overrides.machine } : {}),
    ...(overrides.estimatedCostUsd !== undefined
      ? { estimatedCostUsd: overrides.estimatedCostUsd }
      : {}),
    ...(overrides.actualCostUsd !== undefined
      ? { actualCostUsd: overrides.actualCostUsd }
      : {}),
  };
}

for (const { name, make } of STORES) {
  describe(`${name}: contract`, () => {
    let fixture: StoreFixture;
    let store: StoreLike;

    beforeEach(() => {
      fixture = make();
      store = fixture.store;
    });
    afterEach(() => fixture.cleanup());

    it("getSecret returns undefined when missing", () => {
      expect(store.getSecret("openai")).toBeUndefined();
    });

    it("putSecret + getSecret round-trips", () => {
      store.putSecret("openai", {
        provider: "openai",
        ciphertext: "ct-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const r = store.getSecret("openai");
      expect(r).toEqual({
        provider: "openai",
        ciphertext: "ct-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("putSecret overwrites existing", () => {
      store.putSecret("openai", {
        provider: "openai",
        ciphertext: "v1",
        createdAt: "a",
      });
      store.putSecret("openai", {
        provider: "openai",
        ciphertext: "v2",
        createdAt: "b",
      });
      expect(store.getSecret("openai")?.ciphertext).toBe("v2");
    });

    it("listSecrets enumerates", () => {
      store.putSecret("a", { provider: "a", ciphertext: "x", createdAt: "t1" });
      store.putSecret("b", { provider: "b", ciphertext: "y", createdAt: "t2" });
      const list = store.listSecrets();
      expect(list.map((r) => r.provider).sort()).toEqual(["a", "b"]);
    });

    it("getToken returns undefined when missing", () => {
      expect(store.getToken("nope")).toBeUndefined();
    });

    it("putToken + getToken preserves all fields including scopes array", () => {
      const t = tokenRec({
        id: "t1",
        scopes: ["POST:/v1/foo", "GET:/v1/bar"],
        remaining: 10,
        used: 2,
        expiresAt: 1234567,
        label: "demo",
        revoked: false,
      });
      store.putToken(t);
      expect(store.getToken("t1")).toEqual(t);
    });

    it("listTokens enumerates", () => {
      store.putToken(tokenRec({ id: "a" }));
      store.putToken(tokenRec({ id: "b" }));
      const ids = store.listTokens().map((t) => t.id).sort();
      expect(ids).toEqual(["a", "b"]);
    });

    it("revokeToken returns false when missing, true on success", () => {
      expect(store.revokeToken("missing")).toBe(false);
      store.putToken(tokenRec({ id: "r" }));
      expect(store.revokeToken("r")).toBe(true);
      expect(store.getToken("r")?.revoked).toBe(true);
    });

    describe("consumeToken", () => {
      it("returns 'not_found' when token does not exist", () => {
        expect(store.consumeToken("missing")).toBe("not_found");
      });

      it("decrements remaining and increments used on success", () => {
        store.putToken(tokenRec({ id: "c", remaining: 3 }));
        const r = store.consumeToken("c");
        expect(typeof r === "object").toBe(true);
        if (typeof r === "string") throw new Error("unreachable");
        expect(r.remaining).toBe(2);
        expect(r.used).toBe(1);
        expect(store.getToken("c")?.remaining).toBe(2);
      });

      it("does not decrement when remaining = -1 (unlimited)", () => {
        store.putToken(tokenRec({ id: "u", remaining: -1 }));
        const r = store.consumeToken("u");
        if (typeof r === "string") throw new Error("unreachable");
        expect(r.remaining).toBe(-1);
        expect(r.used).toBe(1);
      });

      it("returns 'exhausted' when remaining = 0", () => {
        store.putToken(tokenRec({ id: "e", remaining: 0 }));
        expect(store.consumeToken("e")).toBe("exhausted");
      });

      it("returns 'revoked' when token is revoked", () => {
        store.putToken(tokenRec({ id: "r", remaining: 5, revoked: true }));
        expect(store.consumeToken("r")).toBe("revoked");
      });

      it("returns 'expired' when token's expiresAt has passed", () => {
        const past = Math.floor(Date.now() / 1000) - 10;
        store.putToken(tokenRec({ id: "x", remaining: 5, expiresAt: past }));
        expect(store.consumeToken("x")).toBe("expired");
      });

      it("expiresAt = 0 means no expiry", () => {
        store.putToken(tokenRec({ id: "f", remaining: 5, expiresAt: 0 }));
        const r = store.consumeToken("f");
        if (typeof r === "string") throw new Error("unreachable");
        expect(r.remaining).toBe(4);
      });

      it("max-calls=1 → second call returns 'exhausted'", () => {
        store.putToken(tokenRec({ id: "one", remaining: 1 }));
        const r1 = store.consumeToken("one");
        const r2 = store.consumeToken("one");
        expect(typeof r1 === "object").toBe(true);
        expect(r2).toBe("exhausted");
      });
    });

    describe("calls / audit", () => {
      it("appendCall + recentCalls round-trip preserves field order", () => {
        const c1 = callRec({ tokenId: "t", path: "/a", reason: "ok-ish" });
        const c2 = callRec({ tokenId: "t", path: "/b" });
        const c3 = callRec({ tokenId: "other", path: "/c" });
        store.appendCall(c1);
        store.appendCall(c2);
        store.appendCall(c3);
        const all = store.recentCalls({ limit: 100 });
        expect(all.length).toBe(3);
        // Chronological order — newest last.
        expect(all[2]?.path).toBe("/c");
      });

      it("recentCalls respects the limit (returns N most recent)", () => {
        for (let i = 0; i < 10; i++) {
          store.appendCall(callRec({ tokenId: "t", path: `/p${i}` }));
        }
        const last3 = store.recentCalls({ limit: 3 });
        expect(last3.length).toBe(3);
        expect(last3.map((c) => c.path)).toEqual(["/p7", "/p8", "/p9"]);
      });

      it("recentCalls filters by tokenId", () => {
        store.appendCall(callRec({ tokenId: "a", path: "/x" }));
        store.appendCall(callRec({ tokenId: "b", path: "/y" }));
        store.appendCall(callRec({ tokenId: "a", path: "/z" }));
        const aOnly = store.recentCalls({ limit: 100, tokenId: "a" });
        expect(aOnly.map((c) => c.path)).toEqual(["/x", "/z"]);
      });

      it("preserves the optional reason field", () => {
        store.appendCall(callRec({ tokenId: "t", outcome: "denied", reason: "scope_denied" }));
        const [only] = store.recentCalls({ limit: 1 });
        expect(only?.outcome).toBe("denied");
        expect(only?.reason).toBe("scope_denied");
      });
    });

    describe("machine attribution (Phase 2.3)", () => {
      it("putToken + getToken preserves the optional machine field", () => {
        const t = tokenRec({ id: "with-mch", machine: "perrypc" });
        store.putToken(t);
        expect(store.getToken("with-mch")?.machine).toBe("perrypc");
      });

      it("putToken + getToken keeps machine undefined when absent", () => {
        store.putToken(tokenRec({ id: "no-mch" }));
        expect(store.getToken("no-mch")?.machine).toBeUndefined();
      });

      it("listTokens filters by machine when opts.machine is set", () => {
        store.putToken(tokenRec({ id: "a", machine: "alpha" }));
        store.putToken(tokenRec({ id: "b", machine: "beta" }));
        store.putToken(tokenRec({ id: "c", machine: "alpha" }));
        store.putToken(tokenRec({ id: "d" })); // no machine
        const alpha = store.listTokens({ machine: "alpha" }).map((t) => t.id).sort();
        const beta = store.listTokens({ machine: "beta" }).map((t) => t.id).sort();
        expect(alpha).toEqual(["a", "c"]);
        expect(beta).toEqual(["b"]);
        expect(store.listTokens().length).toBe(4);
      });

      it("appendCall + recentCalls round-trips the machine field", () => {
        store.appendCall(callRec({ tokenId: "t", machine: "perrypc" }));
        const [only] = store.recentCalls({ limit: 1 });
        expect(only?.machine).toBe("perrypc");
      });

      it("recentCalls filters by machine", () => {
        store.appendCall(callRec({ tokenId: "t", path: "/a", machine: "alpha" }));
        store.appendCall(callRec({ tokenId: "t", path: "/b", machine: "beta" }));
        store.appendCall(callRec({ tokenId: "t", path: "/c", machine: "alpha" }));
        const alphaOnly = store.recentCalls({ limit: 100, machine: "alpha" });
        expect(alphaOnly.map((c) => c.path)).toEqual(["/a", "/c"]);
      });

      it("recentCalls combines tokenId and machine filters", () => {
        store.appendCall(callRec({ tokenId: "t1", path: "/a", machine: "alpha" }));
        store.appendCall(callRec({ tokenId: "t2", path: "/b", machine: "alpha" }));
        store.appendCall(callRec({ tokenId: "t1", path: "/c", machine: "beta" }));
        const r = store.recentCalls({ limit: 100, tokenId: "t1", machine: "alpha" });
        expect(r.map((c) => c.path)).toEqual(["/a"]);
      });
    });

    describe("USD cost accounting (Phase 2.2)", () => {
      it("putToken + getToken preserves the optional capUsd field", () => {
        store.putToken(tokenRec({ id: "with-cap", capUsd: 2.5 }));
        expect(store.getToken("with-cap")?.capUsd).toBe(2.5);
      });

      it("putToken + getToken keeps capUsd undefined when absent", () => {
        store.putToken(tokenRec({ id: "no-cap" }));
        expect(store.getToken("no-cap")?.capUsd).toBeUndefined();
      });

      it("appendCall + recentCalls round-trip both cost columns", () => {
        store.appendCall(
          callRec({
            tokenId: "t",
            estimatedCostUsd: 0.12,
            actualCostUsd: 0.15,
          }),
        );
        const [only] = store.recentCalls({ limit: 1 });
        expect(only?.estimatedCostUsd).toBeCloseTo(0.12, 6);
        expect(only?.actualCostUsd).toBeCloseTo(0.15, 6);
      });

      it("appendCall + recentCalls keeps cost columns undefined when absent", () => {
        // Round-trip parity with logging.ts: optional columns must not
        // get coerced to 0. A missing actualCostUsd means "we never got
        // upstream usage" — distinct from "the call was free".
        store.appendCall(callRec({ tokenId: "t" }));
        const [only] = store.recentCalls({ limit: 1 });
        expect(only?.estimatedCostUsd).toBeUndefined();
        expect(only?.actualCostUsd).toBeUndefined();
      });

      it("sumCostUsdByToken returns 0 for a token with no calls", () => {
        expect(store.sumCostUsdByToken("nope")).toBe(0);
      });

      it("sumCostUsdByToken prefers actualCostUsd over estimatedCostUsd", () => {
        // The 'ok' call's actual ($0.30) wins over its estimate ($0.50).
        // The 'error' call has no actual so its estimate ($0.10) is used.
        // Cumulative = 0.30 + 0.10 = 0.40.
        store.appendCall(
          callRec({ tokenId: "t", outcome: "ok", estimatedCostUsd: 0.5, actualCostUsd: 0.3 }),
        );
        store.appendCall(
          callRec({ tokenId: "t", outcome: "error", estimatedCostUsd: 0.1 }),
        );
        expect(store.sumCostUsdByToken("t")).toBeCloseTo(0.4, 6);
      });

      it("sumCostUsdByToken excludes denied calls (they never hit upstream)", () => {
        // A capped token that's denied for cap_exceeded_estimate must NOT
        // accumulate spend — otherwise the deny itself would push the
        // token closer to the cap, locking it out permanently.
        store.appendCall(
          callRec({ tokenId: "t", outcome: "ok", estimatedCostUsd: 0.2, actualCostUsd: 0.2 }),
        );
        store.appendCall(
          callRec({
            tokenId: "t",
            outcome: "denied",
            reason: "cap_exceeded_estimate",
            estimatedCostUsd: 0.5,
          }),
        );
        expect(store.sumCostUsdByToken("t")).toBeCloseTo(0.2, 6);
      });

      it("sumCostUsdByToken filters by tokenId", () => {
        store.appendCall(callRec({ tokenId: "a", actualCostUsd: 0.1 }));
        store.appendCall(callRec({ tokenId: "b", actualCostUsd: 0.9 }));
        expect(store.sumCostUsdByToken("a")).toBeCloseTo(0.1, 6);
        expect(store.sumCostUsdByToken("b")).toBeCloseTo(0.9, 6);
      });
    });
  });
}

describe("JsonStore: read-only mode (post-migration)", () => {
  it("refuses writes after being marked read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-ro-"));
    try {
      const writable = new JsonStore(
        join(dir, "store.json"),
        join(dir, "calls.log.jsonl"),
      );
      writable.putToken(tokenRec({ id: "x" }));
      const ro = new JsonStore(
        join(dir, "store.json"),
        join(dir, "calls.log.jsonl"),
        true,
      );
      expect(ro.getToken("x")?.id).toBe("x");
      expect(() => ro.putToken(tokenRec({ id: "y" }))).toThrow(/read-only/);
      expect(() => ro.consumeToken("x")).toThrow(/read-only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteStore: schema persistence", () => {
  it("survives close + reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-persist-"));
    const dbPath = join(dir, "store.db");
    try {
      const a = new SqliteStore(dbPath);
      a.putSecret("p", { provider: "p", ciphertext: "ct", createdAt: "now" });
      a.putToken(tokenRec({ id: "t1", remaining: 7 }));
      a.appendCall(callRec({ tokenId: "t1" }));
      a.close?.();

      const b = new SqliteStore(dbPath);
      expect(b.getSecret("p")?.ciphertext).toBe("ct");
      expect(b.getToken("t1")?.remaining).toBe(7);
      expect(b.recentCalls({ limit: 10 }).length).toBe(1);
      b.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteStore: idempotent machine-column migration (Phase 2.3)", () => {
  it("adds the machine column to a pre-2.3 calls/tokens schema without data loss", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "kb-mig-"));
    const dbPath = join(dir, "store.db");
    try {
      // Hand-craft a pre-2.3 schema (no machine columns, requested_model
      // present per Phase 2.1) and seed a row in each table.
      const old = new DatabaseSync(dbPath);
      old.exec(`
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          scopes TEXT NOT NULL,
          remaining INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT 'unlabeled',
          revoked INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID;
        CREATE TABLE calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          token_id TEXT NOT NULL,
          label TEXT NOT NULL,
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          status INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          req_bytes INTEGER NOT NULL,
          resp_bytes INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          requested_model TEXT
        );
      `);
      old
        .prepare(
          `INSERT INTO tokens (id, provider, scopes, remaining, used, expires_at, created_at, label, revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy-t", "echo", '["*"]', 5, 0, 0, "2026-01-01T00:00:00.000Z", "old", 0);
      old
        .prepare(
          `INSERT INTO calls (ts, token_id, label, provider, method, path, status, duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("2026-01-01T00:00:00.000Z", "legacy-t", "old", "echo", "POST", "/v1/x", 200, 1, 0, 0, "ok", null, null);
      old.close();

      // Open with the new code — migrate() should ALTER both tables.
      const s = new SqliteStore(dbPath);
      try {
        // Existing data survived.
        const t = s.getToken("legacy-t");
        expect(t?.id).toBe("legacy-t");
        expect(t?.machine).toBeUndefined();
        const calls = s.recentCalls({ limit: 10 });
        expect(calls.length).toBe(1);
        expect(calls[0]?.machine).toBeUndefined();
        // New writes can use the new field.
        s.putToken(tokenRec({ id: "new-t", machine: "perrypc" }));
        s.appendCall(callRec({ tokenId: "new-t", machine: "perrypc" }));
        expect(s.getToken("new-t")?.machine).toBe("perrypc");
        expect(s.listTokens({ machine: "perrypc" }).length).toBe(1);
        expect(s.recentCalls({ limit: 10, machine: "perrypc" }).length).toBe(1);
      } finally {
        s.close?.();
      }

      // Re-open: migrate() must be a no-op on an already-migrated DB
      // (idempotent — index creation guarded by IF NOT EXISTS, ALTER guarded
      // by PRAGMA table_info check).
      const again = new SqliteStore(dbPath);
      try {
        expect(again.getToken("new-t")?.machine).toBe("perrypc");
      } finally {
        again.close?.();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteStore: idempotent cost-column migration (Phase 2.2)", () => {
  it("adds the cost columns to a pre-2.2 schema without data loss", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "kb-mig22-"));
    const dbPath = join(dir, "store.db");
    try {
      // Hand-craft a Phase 2.3 schema (machine columns present, cost
      // columns absent) and seed each table.
      const old = new DatabaseSync(dbPath);
      old.exec(`
        CREATE TABLE tokens (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          scopes TEXT NOT NULL,
          remaining INTEGER NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          expires_at INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT 'unlabeled',
          revoked INTEGER NOT NULL DEFAULT 0,
          machine TEXT
        ) WITHOUT ROWID;
        CREATE TABLE calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          token_id TEXT NOT NULL,
          label TEXT NOT NULL,
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          status INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          req_bytes INTEGER NOT NULL,
          resp_bytes INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          reason TEXT,
          requested_model TEXT,
          machine TEXT
        );
      `);
      old
        .prepare(
          `INSERT INTO tokens (id, provider, scopes, remaining, used, expires_at, created_at, label, revoked, machine)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy-t", "echo", '["*"]', 5, 0, 0, "2026-01-01T00:00:00.000Z", "old", 0, "perrypc");
      old
        .prepare(
          `INSERT INTO calls (ts, token_id, label, provider, method, path, status, duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("2026-01-01T00:00:00.000Z", "legacy-t", "old", "echo", "POST", "/v1/x", 200, 1, 0, 0, "ok", null, null, "perrypc");
      old.close();

      const s = new SqliteStore(dbPath);
      try {
        // Existing data survived; new columns are null on legacy rows.
        const t = s.getToken("legacy-t");
        expect(t?.machine).toBe("perrypc");
        expect(t?.capUsd).toBeUndefined();
        const calls = s.recentCalls({ limit: 10 });
        expect(calls.length).toBe(1);
        expect(calls[0]?.estimatedCostUsd).toBeUndefined();
        expect(calls[0]?.actualCostUsd).toBeUndefined();

        // sumCostUsdByToken on a legacy-only token returns 0 (NULL costs
        // contribute nothing) — the cap accounting still works after the
        // migration even before any post-2.2 calls land.
        expect(s.sumCostUsdByToken("legacy-t")).toBe(0);

        // New writes can use the new fields.
        s.putToken(tokenRec({ id: "new-t", capUsd: 1.5 }));
        s.appendCall(
          callRec({ tokenId: "new-t", estimatedCostUsd: 0.04, actualCostUsd: 0.05 }),
        );
        expect(s.getToken("new-t")?.capUsd).toBe(1.5);
        expect(s.sumCostUsdByToken("new-t")).toBeCloseTo(0.05, 6);
      } finally {
        s.close?.();
      }

      // Re-open: migrate() must be a no-op on an already-migrated DB.
      const again = new SqliteStore(dbPath);
      try {
        expect(again.getToken("new-t")?.capUsd).toBe(1.5);
        expect(again.sumCostUsdByToken("new-t")).toBeCloseTo(0.05, 6);
      } finally {
        again.close?.();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SqliteStore: openStore mode=auto guard", () => {
  // Migration safety: with a JSON store present and no DB, auto must
  // refuse to start to prevent silently splitting state across two stores.
  it("auto refuses when only the legacy JSON store exists", async () => {
    const { openStore } = await import("../src/store.js");
    const dir = mkdtempSync(join(tmpdir(), "kb-auto-"));
    try {
      writeFileSync(join(dir, "store.json"), '{"version":1,"secrets":{},"tokens":{}}');
      const cfg = {
        dataDir: dir,
        jsonStorePath: join(dir, "store.json"),
        sqliteStorePath: join(dir, "store.db"),
        logsPath: join(dir, "calls.log.jsonl"),
        configPath: join(dir, "config.json"),
        policyPath: join(dir, "policy.json"),
        port: 0,
        host: "127.0.0.1",
        masterKeyHex: "00".repeat(32),
        jwtSecret: "x",
      };
      expect(() => openStore(cfg, { mode: "auto" })).toThrow(/keybroker migrate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
