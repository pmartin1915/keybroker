/**
 * Phase 2.4 — fleet policy: a system-wide guardrail that runs ahead of
 * per-token claims.
 *
 * The policy file (`~/.keybroker/policy.json` by default) lets the operator
 * encode their version of the Money Rule directly into the broker. Even a
 * wildcard token cannot reach a model in `forbidden_models`, and even a
 * correctly-issued token cannot reach a provider that is not in
 * `allowed_providers` (when that list is set).
 *
 * Schema:
 *   {
 *     "forbidden_models":  ["gemini-3-pro-preview", "*-preview"],
 *     "allowed_providers": ["openai", "anthropic"]
 *   }
 *
 * Semantics:
 *   - Both fields are optional. Omitting/empty `allowed_providers` means
 *     no provider restriction; omitting/empty `forbidden_models` means no
 *     model deny-list.
 *   - `forbidden_models` entries are glob patterns (see `glob-match`); `*`
 *     is the only wildcard.
 *   - Missing or unreadable policy file = no enforcement (the broker
 *     intentionally fails OPEN on policy: the policy file is opt-in, and a
 *     parse error during edit must not lock the operator out of their own
 *     tokens. Any active per-token `mdl` claims still apply.).
 *   - Cached for `CACHE_TTL_MS` so the request-path cost is negligible
 *     while still meeting the "changes take effect within a second"
 *     acceptance criterion.
 */
import { existsSync, readFileSync } from "node:fs";
import { matchesAny } from "./glob-match.js";

export interface Policy {
  forbiddenModels: readonly string[];
  allowedProviders: readonly string[];
}

const EMPTY: Policy = { forbiddenModels: [], allowedProviders: [] };

const CACHE_TTL_MS = 1000;

interface CacheEntry {
  policy: Policy;
  loadedAt: number;
}

// Keyed by absolute path so multiple BrokerConfigs (e.g. concurrent test
// suites in the same process) don't poison each other's cache.
const cache = new Map<string, CacheEntry>();

export interface LoadPolicyOptions {
  /** Override the clock for tests. Defaults to `Date.now()`. */
  now?: number;
}

export function loadPolicy(path: string, opts: LoadPolicyOptions = {}): Policy {
  const now = opts.now ?? Date.now();
  const entry = cache.get(path);
  if (entry && now - entry.loadedAt < CACHE_TTL_MS) {
    return entry.policy;
  }
  const policy = readFromDisk(path);
  cache.set(path, { policy, loadedAt: now });
  return policy;
}

function readFromDisk(path: string): Policy {
  if (!existsSync(path)) return EMPTY;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // Fail-open on parse error — see file-level comment.
    console.warn(
      `keybroker: failed to parse policy at ${path} (${(e as Error).message}); ignoring.`,
    );
    return EMPTY;
  }
  return normalize(raw);
}

function normalize(raw: unknown): Policy {
  if (!raw || typeof raw !== "object") return EMPTY;
  const obj = raw as Record<string, unknown>;
  return {
    forbiddenModels: stringArray(obj.forbidden_models),
    allowedProviders: stringArray(obj.allowed_providers),
  };
}

function stringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Returns true if the policy bars this provider entirely. */
export function policyDeniesProvider(p: Policy, provider: string): boolean {
  if (p.allowedProviders.length === 0) return false;
  return !p.allowedProviders.includes(provider);
}

/** Returns true if the policy's forbidden_models list matches `model`. */
export function policyDeniesModel(p: Policy, model: string): boolean {
  if (p.forbiddenModels.length === 0) return false;
  return matchesAny(model, p.forbiddenModels);
}

/**
 * Test-only: drop a single path's cache entry, or the whole cache. The
 * server reaches this only via `loadPolicy`; we never mutate the cache
 * outside this module in production code.
 */
export function _resetPolicyCache(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}
