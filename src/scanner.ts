/**
 * Phase 3.6 / 4.2a — inline secret scanning, Layer 1 + Layer 1.5 (regex +
 * decode-then-scan).
 *
 * The scanner runs against the request body buffer BEFORE upstream is
 * dialled. A hit terminates the request with HTTP 403 and the audit row
 * records `outcome: "egress_blocked"` with `reason: "<detector_name>"`.
 * This is the broker's headline differentiator: not redact, BLOCK.
 *
 * Phase 4.2a adds Layer 1.5: the raw buffer is first scanned as-is, then
 * each of three decoded views (base64, urlencode, json-string-unescape) is
 * scanned in declared order. First detector hit on any view wins. The
 * ScanHit shape and the call site signature are unchanged.
 *
 * Design constraints:
 *   - **Detector names only — never the matched substring.** The matched
 *     bytes are the literal secret we're keeping out of logs. Anywhere
 *     the audit log, console, or response can land, only the detector
 *     name appears. This invariant is load-bearing for compliance: a
 *     scanner that leaks the secret it caught into syslog defeats its
 *     own purpose.
 *   - **Fail open on regex compilation errors.** A misconfigured policy
 *     pattern must not block all traffic — log the warning, skip the
 *     bad detector, continue. (Built-in detectors are compile-tested at
 *     load time, so this only matters for future custom patterns.)
 *   - **First-hit short-circuits.** We don't need an exhaustive list —
 *     one detected secret is enough to block. Bounds the worst-case
 *     latency on adversarial bodies.
 *   - **Max one layer of decoding.** Decoded views are scanned once; the
 *     decoders themselves do not recurse. Nested encoding (base64 of
 *     base64) is never a block trigger on its own.
 *   - **Fail-open on decode errors.** A view that cannot be decoded is
 *     silently skipped; the remaining views and the raw scan are
 *     unaffected.
 *   - **No "matched in decoded view" audit field.** The single terminal
 *     outcome is the detector name — surfacing the path would leak
 *     attacker-helpful information.
 *
 * Layer 2 (TruffleHog verification) lives in Phase 4.2b.
 * Layer 3 (PII) has been dropped from Phase 4.2.
 */

import { DECODERS } from "./decode.js";

/** A single secret pattern. */
export interface Detector {
  /** Stable identifier — what appears in audit logs and 403 responses. */
  readonly name: string;
  /** The matcher. Use `g` flag where possible so RegExp.exec doesn't retain state. */
  readonly pattern: RegExp;
  /**
   * Human-readable label. Not logged or emitted; for `keybroker scanner
   * list` (a future CLI) and for code clarity here.
   */
  readonly description: string;
}

/** Outcome of a scan. */
export interface ScanHit {
  readonly detector: string;
  /**
   * Phase 4.2b: the matched secret bytes extracted from the view that fired
   * (raw or decoded). Stays in-memory only — MUST NEVER appear in audit rows,
   * logs, or 403 responses (invariant 7). Used exclusively to pass the exact
   * secret to the Layer 2 verifier so it receives the decoded token, not a
   * base64-encoded wrapper (invariant 6 forward-pin from Phase 4.2a).
   *
   * Note: the entire ScanHit object is ephemeral — it lives only on the
   * request-handler stack and is never serialised.
   */
  readonly matched?: string;
}

/**
 * Built-in Layer 1 detectors, ordered roughly by precision (least false
 * positives first). The scanner short-circuits on first hit, so order
 * matters when a body could plausibly match more than one — but each of
 * these is independent in practice.
 *
 * Pattern sources (deep-research §4.1) — chosen because each has a fixed
 * prefix that makes the entropy bar irrelevant. Generic-entropy
 * detection (e.g. arbitrary 32-char base64) is intentionally NOT
 * included at Layer 1; it produces too many false positives in code
 * snippets and prose. That's Layer 3 territory.
 */
export const BUILTIN_DETECTORS: readonly Detector[] = [
  {
    name: "aws_access_key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    description: "AWS access key ID (long-lived, IAM user)",
  },
  {
    name: "github_pat",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
    description: "GitHub personal access token (classic)",
  },
  {
    name: "github_oauth",
    pattern: /\bgho_[A-Za-z0-9]{36}\b/g,
    description: "GitHub OAuth access token",
  },
  {
    name: "slack_bot_token",
    pattern: /\bxoxb-\d{10,15}-\d{10,15}-[A-Za-z0-9]{24,40}\b/g,
    description: "Slack bot user OAuth token",
  },
  {
    name: "stripe_live_key",
    pattern: /\bsk_live_[0-9A-Za-z]{24,99}\b/g,
    description: "Stripe live secret API key",
  },
];

/** Look up a detector by name. */
export function getBuiltinDetector(name: string): Detector | undefined {
  return BUILTIN_DETECTORS.find((d) => d.name === name);
}

/**
 * Run one set of detectors against a single text view. Internal helper.
 * Returns the first hit (with matched substring) or null.
 * Resets lastIndex for each `/g` pattern.
 *
 * Phase 4.2b: captures the matched substring so the Layer 2 verifier
 * receives the exact secret bytes from the view that triggered the hit.
 * The matched field is in-memory only and must never be serialised
 * (invariant 7).
 */
function scanText(
  text: string,
  detectors: readonly Detector[],
): ScanHit | null {
  for (const det of detectors) {
    // Reset lastIndex so a `/g` regex doesn't carry state across calls.
    det.pattern.lastIndex = 0;
    const m = det.pattern.exec(text);
    if (m) {
      // m[0] is the matched substring — the literal secret bytes.
      return { detector: det.name, matched: m[0] };
    }
  }
  return null;
}

/**
 * Scan a buffer for the first matching detector. Returns the hit (by
 * detector name) or null if nothing matched.
 *
 * Phase 4.2a — Layer 1.5 extension: after scanning the raw buffer, each
 * decoder in DECODERS is applied (base64, urlencode, json-string-unescape)
 * and the resulting decoded view is scanned with the same detector list.
 * First hit on any view wins. Decode errors are skipped silently (fail-open).
 *
 * The buffer is interpreted as UTF-8 — this matches the broker's body
 * shape: every supported provider sends JSON, which is UTF-8 by spec.
 * Non-UTF-8 bytes round-trip through replacement characters; that's
 * acceptable because the detectors target ASCII-only patterns and
 * non-text bodies (file uploads, etc.) flow through `extractRequestMetadata`'s
 * `no-body` path well before this function sees them.
 *
 * The detectors are scanned in order — first hit wins. Each pattern is
 * given a fresh string slice (no shared exec state across detectors).
 *
 * The call site signature is unchanged from Phase 3.6 (invariant in
 * decision_phase_4_2_a_decoding.md).
 *
 * @param buf - request body bytes. Pass an empty buffer for "nothing to scan".
 * @param detectors - which detectors to apply (typically `BUILTIN_DETECTORS`
 *                    filtered by policy).
 */
export function scanBytes(
  buf: Buffer | undefined,
  detectors: readonly Detector[],
): ScanHit | null {
  if (!buf || buf.byteLength === 0) return null;
  if (detectors.length === 0) return null;

  // Layer 1: raw buffer scan.
  const rawText = buf.toString("utf8");
  const rawHit = scanText(rawText, detectors);
  if (rawHit) return rawHit;

  // Layer 1.5: decoded views, in declared decoder order (first-hit-wins).
  // Max one layer of decoding — decoders themselves do not recurse.
  for (const decoder of DECODERS) {
    let decoded: Buffer | null;
    try {
      decoded = decoder.fn(buf);
    } catch {
      // Unexpected decode error — fail-open (invariant 5), skip view.
      continue;
    }
    if (!decoded || decoded.byteLength === 0) continue;
    const decodedText = decoded.toString("utf8");
    const hit = scanText(decodedText, detectors);
    if (hit) return hit;
  }

  return null;
}

/**
 * Resolve which built-in detectors should run given a policy
 * configuration. Used by server.ts at request time.
 *
 * Semantics:
 *   - If `enabled` is false, returns the empty array (scanner off).
 *   - If `detectors` is undefined or empty, all built-ins run (the
 *     "default-on, opt-out" posture the plan calls for).
 *   - If `detectors` is set, only those names run. Unknown names are
 *     ignored with a warning — typos in policy.json shouldn't take the
 *     scanner offline.
 *
 * @param enabled - policy.scanner.enabled (default: true)
 * @param wantedNames - policy.scanner.detectors (default: undefined → all)
 */
export function resolveDetectors(
  enabled: boolean,
  wantedNames: readonly string[] | undefined,
): readonly Detector[] {
  if (!enabled) return [];
  if (!wantedNames || wantedNames.length === 0) return BUILTIN_DETECTORS;
  const selected: Detector[] = [];
  const unknown: string[] = [];
  for (const name of wantedNames) {
    const found = getBuiltinDetector(name);
    if (found) selected.push(found);
    else unknown.push(name);
  }
  if (unknown.length > 0) {
    console.warn(
      `keybroker: scanner policy references unknown detector(s): ${unknown.join(", ")}. ` +
      `Known detectors: ${BUILTIN_DETECTORS.map((d) => d.name).join(", ")}.`,
    );
  }
  return selected;
}
