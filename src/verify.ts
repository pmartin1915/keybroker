/**
 * Phase 4.2b — Layer 2 verification for github_pat and stripe_live_key.
 *
 * After a Layer 1 / 1.5 regex hit, if verification is enabled for the
 * matched detector, `dispatchVerify` calls the appropriate upstream API
 * to confirm the secret is live. The result feeds the `scan_verified`
 * audit column:
 *
 *   - `1` = upstream confirmed the secret is valid (active threat).
 *   - `0` = upstream said the secret is invalid (block preserved, but
 *            may be a false positive on the regex).
 *   - `null` = verification did not run (detector not in allow-list,
 *              or verify is disabled).
 *
 * Design invariants (from decision_phase_4_2_b_verify.md):
 *
 *   1. On-hit-only. Never runs on the happy path.
 *   2. Two detectors in scope: github_pat and stripe_live_key. AWS deferred.
 *   4. Default fail-CLOSED on verify timeout / 5xx.
 *   5. In-memory sha256-keyed cache, 60s TTL, positive AND negative results.
 *      Transient failures (timeout / network) are NOT cached.
 *   7. Matched secret bytes never persisted or logged. Cache key = sha256(secret).
 *   8. Per-detector timeout 2.5s — not configurable in 4.2b.
 *   9. No new npm dependencies. Node built-ins only: fetch, crypto, AbortSignal.
 *  10. policy.json verify block: enabled, on_failure, detectors.
 *
 * Upstream anomaly-detection caveat (invariant 12): verification makes a live
 * API call. See README for operator-facing notice.
 */

import { createHash } from "node:crypto";

// TODO: import VERSION from package.json when a version shim exists.
// For now, hardcoded to match package.json "version" field.
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  verified: 0 | 1;
  expiresAt: number;
}

// Exported only for `_resetVerifyCache` test helper — not part of public API.
export const _verifyCache = new Map<string, CacheEntry>();

/** Test-only: drop all cached verify results. */
export function _resetVerifyCache(): void {
  _verifyCache.clear();
}

const CACHE_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 2_500;

function cacheKey(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function getCached(secret: string): CacheEntry | undefined {
  const key = cacheKey(secret);
  const entry = _verifyCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    _verifyCache.delete(key);
    return undefined;
  }
  return entry;
}

function setCached(secret: string, verified: 0 | 1): void {
  _verifyCache.set(cacheKey(secret), {
    verified,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ---------------------------------------------------------------------------
// Individual verifiers
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub personal access token via GET /user.
 *
 * Returns:
 *   - `1` if the API returns 200 (token is live and valid).
 *   - `0` if the API returns 401 or 403 (token is invalid / revoked).
 *   - Throws on any other status or network / timeout error.
 *     The dispatcher catches and applies on_failure policy.
 */
export async function verifyGithubPat(secret: string): Promise<0 | 1> {
  const res = await fetch("https://api.github.com/user", {
    method: "GET",
    headers: {
      Authorization: `token ${secret}`,
      "User-Agent": `keybroker/${VERSION}`,
    },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });

  if (res.status === 200) return 1;
  if (res.status === 401 || res.status === 403) return 0;

  // Unexpected status — let dispatcher apply fail-policy.
  throw new Error(
    `github_pat verify: unexpected HTTP ${res.status}`,
  );
}

/**
 * Verify a Stripe live secret key via GET /v1/balance.
 *
 * Returns:
 *   - `1` if the API returns 200 (key is live and valid).
 *   - `0` if the API returns 401 (key is invalid / revoked).
 *   - Throws on any other status or network / timeout error.
 */
export async function verifyStripeLiveKey(secret: string): Promise<0 | 1> {
  const res = await fetch("https://api.stripe.com/v1/balance", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      "User-Agent": `keybroker/${VERSION}`,
    },
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });

  if (res.status === 200) return 1;
  if (res.status === 401) return 0;

  throw new Error(
    `stripe_live_key verify: unexpected HTTP ${res.status}`,
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Verify config as parsed from policy.json `scanner.verify`.
 * Mirrored from policy.ts `VerifyConfig` — imported at runtime from there.
 */
export interface VerifyConfig {
  readonly enabled: boolean;
  readonly on_failure: "block" | "allow";
  readonly detectors: readonly string[];
}

/**
 * Result from `dispatchVerify`.
 *
 * - `verified: 1`   — upstream confirmed the secret is live.
 * - `verified: 0`   — upstream rejected the secret, OR fail-closed fired.
 * - `verified: null` — verify did not run (disabled or detector not in allow-list).
 * - `allow: true`   — set when on_failure="allow" AND the verifier threw;
 *                     server.ts uses this to forward the request rather than block.
 *
 * Invariant 4: fail-CLOSED by default. `allow` is only ever `true` when
 * `on_failure = "allow"` AND a transient error occurred (not a 401/403,
 * which always block regardless of on_failure).
 */
export interface VerifyResult {
  verified: 0 | 1 | null;
  /** Wall-clock ms for the verify call. Null when no call was made. */
  latencyMs: number | null;
  /**
   * When true, the server should forward the request despite the regex hit,
   * because on_failure="allow" and the verifier errored transiently.
   * Always false / absent when verified is 0 or 1.
   */
  allow?: boolean;
}

/**
 * Dispatch a verify call for the given detector and secret bytes.
 *
 * This is the single entry point for server.ts. It:
 *   1. Returns `{ verified: null, latencyMs: null }` if verify is disabled
 *      or the detector is not in the allow-list (invariant 10).
 *   2. Checks the in-memory cache (sha256-keyed). Returns cached result if
 *      not expired.
 *   3. Calls the appropriate verifier with a 2.5s timeout.
 *   4. On 200 / 401 / 403: caches the result and returns it.
 *   5. On throw (timeout, 5xx, network): does NOT cache; applies on_failure.
 *      - on_failure="block": returns `{ verified: 0, latencyMs }`.
 *      - on_failure="allow": returns `{ verified: null, latencyMs, allow: true }`.
 *
 * @param detector - the detector name from the ScanHit.
 * @param secret   - the matched secret bytes from the view that fired the hit
 *                   (raw or decoded, per Phase 4.2a invariant 10 forward-pin).
 * @param cfg      - the parsed scanner.verify config from policy.json.
 */
export async function dispatchVerify(
  detector: string,
  secret: string,
  cfg: VerifyConfig,
): Promise<VerifyResult> {
  const NULL_RESULT: VerifyResult = { verified: null, latencyMs: null };

  // Check master switch and allow-list.
  if (!cfg.enabled) return NULL_RESULT;
  if (!cfg.detectors.includes(detector)) return NULL_RESULT;

  // Cache check.
  const cached = getCached(secret);
  if (cached !== undefined) {
    return { verified: cached.verified, latencyMs: null };
  }

  // Select verifier.
  const verifier = VERIFIERS[detector];
  if (!verifier) {
    // Detector is in the allow-list but has no registered verifier function.
    // This shouldn't happen with the two shipped detectors, but guards against
    // future allow-list entries for unimplemented detectors.
    return NULL_RESULT;
  }

  const t0 = Date.now();
  let latencyMs: number;

  try {
    const result = await verifier(secret);
    latencyMs = Date.now() - t0;
    // Definitive answer (200 / 401 / 403) — cache it.
    setCached(secret, result);
    return { verified: result, latencyMs };
  } catch {
    latencyMs = Date.now() - t0;
    // Transient failure: do NOT cache (invariant 5 rationale: caching transient
    // failures could lock out the operator during a brief upstream outage).
    if (cfg.on_failure === "allow") {
      // Operator-surprising path: a regex hit was forwarded because the
      // verifier failed transiently AND policy is fail-allow. The audit
      // row that follows carries scan_verified=null (no scan info), so
      // this stderr line is the only signal the operator gets.
      // No secret bytes — only detector name and latency.
      console.warn(
        `keybroker: scanner.verify detector=${detector} failed transiently; ` +
          `on_failure=allow → forwarding request. ` +
          `latency_ms=${latencyMs}`,
      );
      return { verified: null, latencyMs, allow: true };
    }
    // Default: fail-CLOSED (invariant 4).
    return { verified: 0, latencyMs };
  }
}

// Registered verifiers keyed by detector name.
const VERIFIERS: Record<string, (secret: string) => Promise<0 | 1>> = {
  github_pat: verifyGithubPat,
  stripe_live_key: verifyStripeLiveKey,
  // aws_access_key: deferred (invariant 2 — requires key-pair extraction).
};
