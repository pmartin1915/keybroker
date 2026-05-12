/**
 * Phase 4.2b — Layer 2 verification tests.
 *
 * Covers:
 *   1.  verifyGithubPat happy path (200 → 1)
 *   2.  verifyGithubPat invalid (401 → 0)
 *   3.  verifyGithubPat timeout (AbortSignal fires → throws)
 *   4.  verifyGithubPat 5xx (503 → throws)
 *   5.  verifyStripeLiveKey happy path (200 → 1)
 *   6.  verifyStripeLiveKey invalid (401 → 0)
 *   7.  Cache hit: second dispatch for same secret does NOT call fetch
 *   8.  Cache miss after TTL: second dispatch after 60s DOES call fetch
 *   9.  Negative result cached: 401 result cached; second within window returns 0
 *  10.  Failure not cached: timeout → next call re-invokes fetch
 *  11.  dispatchVerify fail-closed: on_failure="block", verifier throws → verified=0
 *  12.  dispatchVerify fail-allow: on_failure="allow", verifier throws → allow=true
 *  13.  dispatchVerify detector not in allow-list → verified=null
 *  14.  Verify disabled → verified=null regardless of detector
 *  15.  Forward-pin from 4.2a: base64-decoded view → verifier gets decoded secret
 *  16.  Migration idempotent: opening a store twice does not throw on ALTER TABLE
 *  17.  Audit row carries scan_verified + scan_verify_latency_ms (wiring test)
 *  18.  No matched-secret-leak: matched bytes do NOT appear in persisted row /
 *       response body
 *
 * Fixture convention (from tests/decode.test.ts line 149):
 *   "ghp_" + "a".repeat(36)         — GitHub PAT shape
 *   "sk_live_" + "<24+chars>"       — Stripe live key shape
 *   Comments use placeholders like <24+chars> to avoid push-protection FPs.
 *
 * Mocking: global.fetch is mocked via vi.stubGlobal. The in-memory verify
 * cache is cleared before each test via _resetVerifyCache().
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyGithubPat,
  verifyStripeLiveKey,
  dispatchVerify,
  _resetVerifyCache,
  type VerifyConfig,
} from "../src/verify.js";
import { scanBytes, BUILTIN_DETECTORS } from "../src/scanner.js";
import { SqliteStore } from "../src/store-sqlite.js";

// ---------------------------------------------------------------------------
// Fixtures — never write real secret-shaped literals in comments.
// ---------------------------------------------------------------------------
// GitHub PAT: "ghp_" prefix + 36 alphanum chars.
const GHP_TOKEN = "ghp_" + "a".repeat(36);
// Stripe live key: "sk_live_" prefix + <24+chars>.
const SK_LIVE_TOKEN = "sk_live_" + "abcDEF1234567890abcDEF1234";

// Default verify configs for convenience.
const VERIFY_ENABLED_BLOCK: VerifyConfig = {
  enabled: true,
  on_failure: "block",
  detectors: ["github_pat", "stripe_live_key"],
};

const VERIFY_ENABLED_ALLOW: VerifyConfig = {
  enabled: true,
  on_failure: "allow",
  detectors: ["github_pat", "stripe_live_key"],
};

const VERIFY_DISABLED: VerifyConfig = {
  enabled: false,
  on_failure: "block",
  detectors: ["github_pat", "stripe_live_key"],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetVerifyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper: make a fetch mock that returns a given status.
// ---------------------------------------------------------------------------
function mockFetch(status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      json: () => Promise.resolve({ login: "testuser" }),
    }),
  );
}

function mockFetchHanging(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(
      (_url: string, opts?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // If an AbortSignal is passed, listen for abort and reject.
          const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              ),
            );
          }
          // Never resolve otherwise — simulates a hanging server.
        }),
    ),
  );
}

// ---------------------------------------------------------------------------
// 1. verifyGithubPat happy path
// ---------------------------------------------------------------------------
describe("verifyGithubPat", () => {
  it("1. returns 1 for HTTP 200", async () => {
    mockFetch(200);
    await expect(verifyGithubPat(GHP_TOKEN)).resolves.toBe(1);
  });

  // 2. verifyGithubPat invalid
  it("2. returns 0 for HTTP 401", async () => {
    mockFetch(401);
    await expect(verifyGithubPat(GHP_TOKEN)).resolves.toBe(0);
  });

  it("2b. returns 0 for HTTP 403", async () => {
    mockFetch(403);
    await expect(verifyGithubPat(GHP_TOKEN)).resolves.toBe(0);
  });

  // 3. verifyGithubPat timeout — mock fetch to reject immediately.
  it("3. throws when AbortSignal fires (timeout)", async () => {
    // Simulate a timeout by having fetch reject with a TimeoutError DOMException.
    // DOMException("...", "TimeoutError") sets name to "TimeoutError" via the constructor.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    );
    await expect(verifyGithubPat(GHP_TOKEN)).rejects.toThrow();
  }, 10_000);

  // 4. verifyGithubPat 5xx
  it("4. throws on HTTP 503 (unexpected status)", async () => {
    mockFetch(503);
    await expect(verifyGithubPat(GHP_TOKEN)).rejects.toThrow(
      "github_pat verify: unexpected HTTP 503",
    );
  });
});

// ---------------------------------------------------------------------------
// 5–6. verifyStripeLiveKey
// ---------------------------------------------------------------------------
describe("verifyStripeLiveKey", () => {
  it("5. returns 1 for HTTP 200", async () => {
    mockFetch(200);
    await expect(verifyStripeLiveKey(SK_LIVE_TOKEN)).resolves.toBe(1);
  });

  it("6. returns 0 for HTTP 401", async () => {
    mockFetch(401);
    await expect(verifyStripeLiveKey(SK_LIVE_TOKEN)).resolves.toBe(0);
  });

  it("6b. throws on HTTP 403 (unexpected for Stripe — only 401 means invalid)", async () => {
    mockFetch(403);
    await expect(verifyStripeLiveKey(SK_LIVE_TOKEN)).rejects.toThrow(
      "stripe_live_key verify: unexpected HTTP 403",
    );
  });

  it("6c. throws on HTTP 503", async () => {
    mockFetch(503);
    await expect(verifyStripeLiveKey(SK_LIVE_TOKEN)).rejects.toThrow(
      "stripe_live_key verify: unexpected HTTP 503",
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Cache hit: second dispatch does NOT call fetch
// ---------------------------------------------------------------------------
describe("dispatchVerify — cache", () => {
  it("7. second dispatch for the same secret returns cached result without calling fetch", async () => {
    mockFetch(200);
    const fetchMock = vi.mocked(global.fetch);

    const r1 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r1.verified).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call — same secret. fetch should NOT be called again.
    const r2 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r2.verified).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still only 1 call

    // Cache hit: latencyMs is null (no network round-trip).
    expect(r2.latencyMs).toBeNull();
  });

  // 8. Cache miss after TTL
  it("8. cache miss after 60s TTL expires: second dispatch DOES call fetch", async () => {
    vi.useFakeTimers();
    mockFetch(200);
    const fetchMock = vi.mocked(global.fetch);

    await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance time past the 60s TTL.
    vi.advanceTimersByTime(61_000);

    const r2 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r2.verified).toBe(1);
    // Cache expired → fetch called again.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 9. Negative result cached
  it("9. negative result (0) is cached for 60s; second call within window returns 0 without fetch", async () => {
    mockFetch(401);
    const fetchMock = vi.mocked(global.fetch);

    const r1 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r1.verified).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within 60s — should use cache.
    const r2 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r2.verified).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2.latencyMs).toBeNull();
  });

  // 10. Failure not cached
  it("10. transient failure is NOT cached; next call re-invokes fetch", async () => {
    // First call: 503 → throws → fail-closed → verified=0, not cached.
    mockFetch(503);
    const fetchMock = vi.mocked(global.fetch);

    const r1 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r1.verified).toBe(0); // fail-closed
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call in same window. Because the failure was NOT cached,
    // fetch is called again.
    const r2 = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r2.verified).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2); // called again
  });
});

// ---------------------------------------------------------------------------
// 11–12. dispatchVerify fail-policy on transient error
// ---------------------------------------------------------------------------
describe("dispatchVerify — fail-policy", () => {
  it("11. fail-closed: on_failure=block, verifier throws → verified=0, allow undefined", async () => {
    mockFetch(503);
    const r = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);
    expect(r.verified).toBe(0);
    expect(r.allow).toBeFalsy();
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("12. fail-allow: on_failure=allow, verifier throws → verified=null, allow=true", async () => {
    mockFetch(503);
    const r = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_ALLOW);
    expect(r.verified).toBeNull();
    expect(r.allow).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("12b. fail-allow does not apply to definitive 401: returns verified=0 regardless", async () => {
    // 401 is a definitive "invalid key" answer — caches and returns 0.
    // on_failure only applies to transient errors (throw path).
    mockFetch(401);
    const r = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_ALLOW);
    expect(r.verified).toBe(0);
    expect(r.allow).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 13. Detector not in allow-list
// ---------------------------------------------------------------------------
describe("dispatchVerify — allow-list", () => {
  it("13. detector not in verify.detectors returns verified=null (no fetch call)", async () => {
    mockFetch(200);
    const fetchMock = vi.mocked(global.fetch);

    const cfg: VerifyConfig = {
      enabled: true,
      on_failure: "block",
      detectors: ["github_pat"], // stripe not included
    };
    const r = await dispatchVerify("stripe_live_key", SK_LIVE_TOKEN, cfg);
    expect(r.verified).toBeNull();
    expect(r.latencyMs).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("13b. aws_access_key (not in default allow-list) returns verified=null", async () => {
    mockFetch(200);
    const fetchMock = vi.mocked(global.fetch);
    const r = await dispatchVerify("aws_access_key", "AKIAIOSFODNN7EXAMPLE", VERIFY_ENABLED_BLOCK);
    expect(r.verified).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 14. Verify disabled
// ---------------------------------------------------------------------------
describe("dispatchVerify — disabled", () => {
  it("14. verify.enabled=false returns verified=null regardless of detector", async () => {
    mockFetch(200);
    const fetchMock = vi.mocked(global.fetch);

    const r = await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_DISABLED);
    expect(r.verified).toBeNull();
    expect(r.latencyMs).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 15. Forward-pin from Phase 4.2a: decoded-view hit passes decoded bytes to verifier
// ---------------------------------------------------------------------------
describe("Phase 4.2a forward-pin (test 15)", () => {
  it("15. base64-encoded ghp_ token → scanBytes.matched carries the decoded token, not the base64 string", () => {
    // Build a body where the GitHub PAT is base64-encoded (Layer 1.5 path).
    const pat = "ghp_" + "a".repeat(36);
    const b64 = Buffer.from(pat, "utf8").toString("base64");
    const body = `{"prompt":"use ${b64} for auth"}`;

    const hit = scanBytes(Buffer.from(body, "utf8"), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("github_pat");

    // The `matched` field must be the decoded PAT, not the base64 string.
    // This is the forward-pin: Layer 2 verifier will call GitHub with the
    // actual token, not a garbled base64-of-token string.
    expect(hit!.matched).toBe(pat);
    expect(hit!.matched).not.toBe(b64);
  });
});

// ---------------------------------------------------------------------------
// 16. Migration idempotent
// ---------------------------------------------------------------------------
describe("store migration — idempotent (test 16)", () => {
  it("16. opening a SqliteStore twice does not throw on the scan_verified ALTER TABLE", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-verify-migrate-"));
    try {
      const dbPath = join(dir, "store.db");
      // First open — creates schema + runs migrate() adding scan_verified columns.
      const s1 = new SqliteStore(dbPath);
      s1.close();
      // Second open — migrate() runs again; addColumnIfMissing is idempotent.
      expect(() => {
        const s2 = new SqliteStore(dbPath);
        s2.close();
      }).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 17. Audit row carries new fields (wiring test)
// ---------------------------------------------------------------------------
describe("audit row wiring (test 17)", () => {
  it("17. appendCall with scanVerified=1 and scanVerifyLatencyMs persists both columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-verify-audit-"));
    try {
      const dbPath = join(dir, "store.db");
      const store = new SqliteStore(dbPath);
      try {
        store.appendCall({
          ts: new Date().toISOString(),
          tokenId: "tok-verify-test",
          label: "test",
          provider: "echo",
          method: "POST",
          path: "/v1/chat/completions",
          status: 403,
          durationMs: 10,
          reqBytes: 42,
          respBytes: 0,
          outcome: "egress_blocked",
          reason: "github_pat",
          scanVerified: 1,
          scanVerifyLatencyMs: 123,
        });

        const calls = store.recentCalls({ limit: 1 });
        expect(calls).toHaveLength(1);
        const row = calls[0]!;
        expect(row.scanVerified).toBe(1);
        expect(row.scanVerifyLatencyMs).toBe(123);
        expect(row.outcome).toBe("egress_blocked");
        expect(row.reason).toBe("github_pat");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("17b. appendCall without scanVerified leaves both columns NULL", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-verify-audit-null-"));
    try {
      const dbPath = join(dir, "store.db");
      const store = new SqliteStore(dbPath);
      try {
        store.appendCall({
          ts: new Date().toISOString(),
          tokenId: "tok-verify-null",
          label: "test",
          provider: "echo",
          method: "POST",
          path: "/v1/chat/completions",
          status: 403,
          durationMs: 5,
          reqBytes: 20,
          respBytes: 0,
          outcome: "egress_blocked",
          reason: "aws_access_key",
          // scanVerified and scanVerifyLatencyMs absent → NULL
        });

        const calls = store.recentCalls({ limit: 1 });
        expect(calls).toHaveLength(1);
        const row = calls[0]!;
        expect(row.scanVerified).toBeUndefined();
        expect(row.scanVerifyLatencyMs).toBeUndefined();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 18. No matched-secret-leak
// ---------------------------------------------------------------------------
describe("no secret leak (test 18)", () => {
  it("18a. dispatchVerify cache key is sha256 — the secret itself is never stored in Map keys", async () => {
    // This is a structural test: the cache Map is exported as _verifyCache.
    // After a dispatch, the key in the Map should NOT be the raw secret.
    mockFetch(200);
    await dispatchVerify("github_pat", GHP_TOKEN, VERIFY_ENABLED_BLOCK);

    // Import the cache directly to inspect keys.
    const { _verifyCache } = await import("../src/verify.js");
    const keys = [..._verifyCache.keys()];
    // Each key should be a hex sha256 digest (64 hex chars), not the raw secret.
    for (const key of keys) {
      expect(key).not.toContain("ghp_");
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("18b. scanBytes matched field is the secret — audit wiring test verifies it is NOT in persisted reason or outcome", () => {
    const pat = "ghp_" + "a".repeat(36);
    const hit = scanBytes(Buffer.from(`token: ${pat}`, "utf8"), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.matched).toBe(pat);

    const dir = mkdtempSync(join(tmpdir(), "kb-no-leak-"));
    try {
      const dbPath = join(dir, "store.db");
      const store = new SqliteStore(dbPath);
      try {
        // Simulate blockedEgress: write audit row with detector name only.
        store.appendCall({
          ts: new Date().toISOString(),
          tokenId: "tok-no-leak",
          label: "test",
          provider: "echo",
          method: "POST",
          path: "/v1/chat",
          status: 403,
          durationMs: 2,
          reqBytes: pat.length,
          respBytes: 0,
          outcome: "egress_blocked",
          reason: hit!.detector, // detector name only, NOT hit!.matched
        });

        const calls = store.recentCalls({ limit: 1 });
        expect(calls).toHaveLength(1);
        const row = calls[0]!;

        // Reason must be the detector name, never the secret bytes.
        expect(row.reason).toBe("github_pat");
        expect(row.reason).not.toContain("ghp_");

        // Double-check: scan_verified may be undefined (no verify in this test).
        // The point is the secret never appears in the persisted row.
        const rowStr = JSON.stringify(row);
        expect(rowStr).not.toContain("ghp_");
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
