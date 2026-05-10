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
