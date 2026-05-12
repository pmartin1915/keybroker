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
 *     "allowed_providers": ["openai", "anthropic"],
 *     "tag_allowlist":     {
 *       "team":    ["platform", "infra"],
 *       "project": ["dispatcher", "broker"]
 *       // env omitted -> any non-empty string ≤ MAX_TAG_VALUE_LEN accepted
 *     }
 *   }
 *
 * Semantics:
 *   - All top-level fields are optional. Omitting/empty `allowed_providers`
 *     means no provider restriction; omitting/empty `forbidden_models`
 *     means no model deny-list.
 *   - `forbidden_models` entries are glob patterns (see `glob-match`); `*`
 *     is the only wildcard.
 *   - `tag_allowlist` (Phase 3.3) is per-tag: each of `team`/`project`/`env`
 *     can be an array of legal values. Tags omitted from the allow-list
 *     map are unrestricted — the CLI accepts any non-empty short string
 *     (still bounded by the MAX_TAG_VALUE_LEN guard in tokens.ts). An
 *     explicit empty array (e.g. `"team": []`) is treated identically
 *     to "key omitted" so editing one to clear it can't accidentally
 *     forbid all team tags.
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

export interface TagAllowlist {
  team?: readonly string[];
  project?: readonly string[];
  env?: readonly string[];
}

export type TagKey = "team" | "project" | "env";

/**
 * Phase 4.2b — Layer 2 verification configuration.
 *
 * Lives under `scanner.verify` in policy.json. Controls whether the broker
 * makes a live upstream API call to confirm a regex-matched secret is
 * actually valid. Verification is fail-CLOSED by default (invariant 4):
 * a timeout or upstream error blocks the request unless the operator opts
 * to `on_failure: "allow"`.
 *
 * IMPORTANT: verification is a live API call and has side effects on the
 * upstream — see the README for the operator-facing caveat.
 */
export interface VerifyConfig {
  /**
   * Master switch for Layer 2 verification. Defaults to true.
   * Set to false to disable verification entirely (audit rows will have
   * scan_verified = NULL on all hits).
   */
  readonly enabled: boolean;
  /**
   * What to do when the verifier throws (timeout, 5xx, network error).
   * - "block" (default): treat as verified=0, block the request.
   * - "allow": treat as a transient failure, forward the request.
   * Does NOT affect definitive 401/403 responses — those always block.
   */
  readonly on_failure: "block" | "allow";
  /**
   * Allow-list of detector names to verify. Detectors not in this list
   * produce scan_verified=NULL on hit. Unknown names are logged and ignored.
   * Default: ["github_pat", "stripe_live_key"].
   */
  readonly detectors: readonly string[];
}

const DEFAULT_VERIFY: VerifyConfig = {
  enabled: true,
  on_failure: "block",
  // Phase 4.2c: aws_access_key added. Layer 2 verification fires only when
  // the scanner also extracted the paired secret access key within the
  // proximity window; AKIA-only hits short-circuit to scan_verified=null.
  detectors: ["github_pat", "stripe_live_key", "aws_access_key"],
};

/**
 * Phase 3.6 — inline scanner configuration.
 *
 * Default posture is **on with all built-in detectors**: if `policy.json`
 * has no `scanner` key (or the file is absent), `enabled` is true and
 * `detectors` is undefined (meaning "all built-ins"). Operators opt OUT
 * with `"scanner": { "enabled": false }`. This matches the plan's
 * strategic positioning — egress-blocked is a first-class outcome that
 * should be on by default, not buried behind opt-in.
 *
 * Phase 4.2b adds the `verify` sub-block (see VerifyConfig above).
 */
export interface ScannerConfig {
  /** Master switch. Defaults to true. */
  readonly enabled: boolean;
  /**
   * Allow-list of detector names to run. `undefined` (the default) means
   * "all built-ins". Unknown names are logged and ignored at request
   * time so a typo can't take the whole scanner offline.
   */
  readonly detectors?: readonly string[];
  /** Phase 4.2b: Layer 2 verification config. Defaults to verify-enabled, fail-closed. */
  readonly verify: VerifyConfig;
}

export interface Policy {
  forbiddenModels: readonly string[];
  allowedProviders: readonly string[];
  tagAllowlist: TagAllowlist;
  scanner: ScannerConfig;
}

const DEFAULT_SCANNER: ScannerConfig = { enabled: true, verify: DEFAULT_VERIFY };

const EMPTY: Policy = {
  forbiddenModels: [],
  allowedProviders: [],
  tagAllowlist: {},
  scanner: DEFAULT_SCANNER,
};

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
    tagAllowlist: tagAllowlistFromRaw(obj.tag_allowlist),
    scanner: scannerConfigFromRaw(obj.scanner),
  };
}

function scannerConfigFromRaw(v: unknown): ScannerConfig {
  // Missing or non-object: default-on with all built-ins. Fail-OPEN
  // semantics here mean "scanner runs when policy is misconfigured" —
  // the opposite of the policy file's overall fail-open behavior, but
  // intentional: a malformed `scanner` key shouldn't disable the
  // headline differentiator.
  if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_SCANNER;
  const obj = v as Record<string, unknown>;
  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
  const detectors = Array.isArray(obj.detectors)
    ? stringArray(obj.detectors)
    : undefined;
  // Distinguish "key absent" from "empty array": both currently collapse
  // to "all built-ins" at the resolver, but we preserve the array shape
  // so a future "explicit empty = nothing" semantic could land without
  // a normalize change.
  const verify = verifyConfigFromRaw(obj.verify);
  return detectors === undefined
    ? { enabled, verify }
    : { enabled, detectors, verify };
}

/**
 * Phase 4.2b: parse the `scanner.verify` sub-block from policy.json.
 * Fail-OPEN on missing / malformed: default is verify-enabled with
 * fail-CLOSED. This is deliberate — a typo in the verify block should not
 * silently disable the Layer 2 check. Operators who want to disable
 * verification must set `"enabled": false` explicitly.
 */
export function verifyConfigFromRaw(v: unknown): VerifyConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_VERIFY;
  const obj = v as Record<string, unknown>;
  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
  const onFailure =
    obj.on_failure === "allow" ? "allow" as const : "block" as const;
  // detectors: if absent or malformed, use the default allow-list.
  const detectors = Array.isArray(obj.detectors)
    ? stringArray(obj.detectors)
    : DEFAULT_VERIFY.detectors;
  // Warn on unknown detector names in the verify allow-list, same as
  // the Layer 1 resolveDetectors pattern.
  if (Array.isArray(obj.detectors)) {
    const KNOWN = new Set(["github_pat", "stripe_live_key", "aws_access_key"]);
    const unknown = (detectors as string[]).filter((d) => !KNOWN.has(d));
    if (unknown.length > 0) {
      console.warn(
        `keybroker: scanner.verify.detectors references unknown verifier(s): ${unknown.join(", ")}. ` +
          `Known verifiable detectors: github_pat, stripe_live_key, aws_access_key.`,
      );
    }
  }
  return { enabled, on_failure: onFailure, detectors };
}

function stringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function tagAllowlistFromRaw(v: unknown): TagAllowlist {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const obj = v as Record<string, unknown>;
  const out: TagAllowlist = {};
  // Only keep keys that have at least one usable value. An empty array
  // collapses to "no restriction" (see file-level comment).
  for (const k of ["team", "project", "env"] as const) {
    const arr = stringArray(obj[k]);
    if (arr.length > 0) out[k] = arr;
  }
  return out;
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
 * Phase 3.3: returns true if `value` is not in the configured allow-list
 * for `key`. Unconfigured / empty allow-lists return false (free-form for
 * that tag). Used by the CLI at issue time; the broker does NOT call
 * this on the request path — token claims are trusted as signed.
 */
export function policyDeniesTag(
  p: Policy,
  key: TagKey,
  value: string,
): boolean {
  const list = p.tagAllowlist[key];
  if (!list || list.length === 0) return false;
  return !list.includes(value);
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
