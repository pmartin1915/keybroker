import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface BrokerClaims extends JWTPayload {
  /** Provider this token may access. */
  prv: string;
  /** Allowed scopes, e.g. ["POST:/v1/chat/completions"]. */
  scp: string[];
  /** Free-form label for audit. */
  lbl: string;
  /**
   * Optional model allow-list. Empty/missing means no model restriction —
   * the request body is not inspected. When set, the upstream provider must
   * implement extractRequestedModel; the requested model must be a member
   * of this list or the request is denied 403 model_not_allowed.
   */
  mdl?: string[];
  /**
   * Phase 2.3: machine that issued this token (typically `os.hostname()`).
   * Recorded into the audit log for per-machine attribution and used by
   * `keybroker tokens --machine` / `revoke-all --machine`. Optional so
   * pre-2.3 tokens still verify; the broker NEVER enforces presence.
   *
   * Phase 3.0 contract: this field SHOULD be the normalized form
   * (`normalizeMachine` from `src/hostname.ts` — lowercase + trim).
   * The CLI normalizes at issue time; programmatic callers of
   * `issueToken` are expected to do the same. The broker does NOT
   * re-normalize on verify, so a JWT minted with mixed-case `mch`
   * will simply not match `--machine` filters. This is intentional —
   * verification trusts what was signed.
   */
  mch?: string;
  /**
   * Phase 2.2: per-token absolute USD cap. Optional; when set the broker
   * estimates each call's cost from `model + max_tokens` and refuses any
   * request that would push the token's cumulative spend above this value.
   * Spend is computed on demand from the audit log. `cap` is dollars (with
   * decimals); 0 / missing = no cap. issueToken refuses non-positive caps
   * and verifyToken rejects malformed claims (non-number / non-finite /
   * negative / zero) so a hand-crafted JWT cannot disable enforcement.
   */
  cap?: number;
  /**
   * Phase 3.3: token tags for FinOps attribution. Optional. Each subkey
   * (`t`=team, `p`=project, `e`=env) is independently optional. The
   * CLI validates values against `policy.tagAllowlist` at issue time;
   * the broker does NOT re-check policy on each request — the claim is
   * trusted as signed (parallel to `mch`/`cap`). verifyToken rejects
   * malformed shapes (non-string, empty string, oversized values, or a
   * vacuous `{}`) so a hand-crafted JWT can't smuggle garbage into the
   * audit log.
   */
  tag?: BrokerTagClaim;
}

export interface BrokerTagClaim {
  /** Team. */
  t?: string;
  /** Project. */
  p?: string;
  /** Environment. */
  e?: string;
}

export const TOKEN_PREFIX = "brk_";

/**
 * Phase 3.3: cap on a single tag value. Generous enough for slugs and
 * short human names, tight enough that a malicious caller can't bloat
 * the audit log or the JWT itself.
 */
export const MAX_TAG_VALUE_LEN = 64;

export async function issueToken(
  secret: string,
  args: {
    tokenId: string;
    provider: string;
    scopes: string[];
    label: string;
    /** Seconds until expiry. 0 = no expiry. */
    ttlSeconds: number;
    /** Optional model allow-list. Empty/undefined → no restriction. */
    models?: string[];
    /** Optional machine identifier (typically os.hostname()). Empty/undefined → no claim. */
    machine?: string;
    /** Optional per-token USD cap. Must be > 0 and finite; 0/undefined → no cap. */
    capUsd?: number;
    /**
     * Phase 3.3: optional tags. Each value, when present, must be a
     * non-empty string ≤ MAX_TAG_VALUE_LEN. Empty/undefined values are
     * silently dropped. If every tag is dropped, no `tag` claim is
     * emitted at all — parallel to the `machine: ""` handling.
     * Allow-list enforcement is the caller's job (see policyDeniesTag);
     * issueToken only validates shape and length.
     */
    tags?: { team?: string; project?: string; env?: string };
  },
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const payload: Record<string, unknown> = {
    prv: args.provider,
    scp: args.scopes,
    lbl: args.label,
  };
  if (args.models && args.models.length > 0) {
    payload.mdl = args.models;
  }
  if (args.machine && args.machine.length > 0) {
    payload.mch = args.machine;
  }
  if (args.capUsd !== undefined && args.capUsd !== 0) {
    if (
      typeof args.capUsd !== "number" ||
      !Number.isFinite(args.capUsd) ||
      args.capUsd < 0
    ) {
      // Issue-time guard: a negative / non-finite cap would either
      // disable enforcement (negative shifts every comparison true) or
      // break the comparison (NaN/Infinity). 0 and undefined both mean
      // "no cap" by contract — let those through silently as a no-op.
      throw new Error(
        `issueToken: capUsd must be a positive finite number (got ${String(args.capUsd)})`,
      );
    }
    payload.cap = args.capUsd;
  }
  const tagClaim = buildTagClaim(args.tags);
  if (tagClaim !== undefined) {
    payload.tag = tagClaim;
  }
  const builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("keybroker")
    .setSubject(args.tokenId)
    .setJti(args.tokenId)
    .setIssuedAt();
  if (args.ttlSeconds > 0) {
    builder.setExpirationTime(Math.floor(Date.now() / 1000) + args.ttlSeconds);
  }
  const jwt = await builder.sign(key);
  return TOKEN_PREFIX + jwt;
}

/**
 * Build the `tag` claim payload from caller-friendly `{team, project, env}`.
 * Drops undefined / empty values; throws on values that exceed
 * MAX_TAG_VALUE_LEN. Returns undefined if no usable tag remains so the
 * caller can omit the claim entirely.
 */
function buildTagClaim(
  tags: { team?: string; project?: string; env?: string } | undefined,
): BrokerTagClaim | undefined {
  if (!tags) return undefined;
  const out: BrokerTagClaim = {};
  const map = [
    ["team", "t", tags.team],
    ["project", "p", tags.project],
    ["env", "e", tags.env],
  ] as const;
  for (const [name, key, value] of map) {
    if (value === undefined || value.length === 0) continue;
    if (value.length > MAX_TAG_VALUE_LEN) {
      throw new Error(
        `issueToken: ${name} tag exceeds ${MAX_TAG_VALUE_LEN} chars (got ${value.length})`,
      );
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

export async function verifyToken(
  secret: string,
  raw: string,
): Promise<{ tokenId: string; claims: BrokerClaims } | { error: string }> {
  if (!raw.startsWith(TOKEN_PREFIX)) {
    return { error: "missing_prefix" };
  }
  const jwt = raw.slice(TOKEN_PREFIX.length);
  const key = new TextEncoder().encode(secret);
  try {
    const { payload } = await jwtVerify(jwt, key, { issuer: "keybroker" });
    const claims = payload as BrokerClaims;
    if (!claims.jti || !claims.prv || !Array.isArray(claims.scp)) {
      return { error: "malformed_claims" };
    }
    if (claims.mdl !== undefined) {
      if (!Array.isArray(claims.mdl) || !claims.mdl.every((m) => typeof m === "string")) {
        return { error: "malformed_claims" };
      }
    }
    if (
      claims.mch !== undefined &&
      (typeof claims.mch !== "string" || claims.mch.length === 0)
    ) {
      return { error: "malformed_claims" };
    }
    if (
      claims.cap !== undefined &&
      (typeof claims.cap !== "number" ||
        !Number.isFinite(claims.cap) ||
        claims.cap <= 0)
    ) {
      // Symmetry with the issue-time guard. A hand-crafted JWT with
      // `cap: 0` or `cap: -1` could otherwise sneak past the cap check
      // (which only fires on `cap !== undefined && cap > 0`).
      return { error: "malformed_claims" };
    }
    if (claims.tag !== undefined) {
      if (
        typeof claims.tag !== "object" ||
        claims.tag === null ||
        Array.isArray(claims.tag)
      ) {
        return { error: "malformed_claims" };
      }
      const tag = claims.tag as Record<string, unknown>;
      // A vacuous {} claim never comes from issueToken (it omits the
      // claim instead). Treating it as malformed forces the only
      // legitimate "no tag" path to be `tag` absent — keeping audit
      // consumers from having to special-case empty objects.
      if (tag.t === undefined && tag.p === undefined && tag.e === undefined) {
        return { error: "malformed_claims" };
      }
      for (const k of ["t", "p", "e"] as const) {
        const v = tag[k];
        if (v === undefined) continue;
        if (
          typeof v !== "string" ||
          v.length === 0 ||
          v.length > MAX_TAG_VALUE_LEN
        ) {
          return { error: "malformed_claims" };
        }
      }
    }
    return { tokenId: claims.jti, claims };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Scope check. Format: "<METHOD>:<path-prefix>" or "*" for full wildcard.
 *
 * Path matching requires a segment boundary at the prefix end so that
 * scope `POST:/v1/chat/completions` does NOT match `/v1/chat/completionsEVIL`.
 * The `path` argument MUST already be normalized — any `..` segments will
 * cause an immediate deny, since they suggest the caller is trying to slip
 * past a prefix boundary.
 */
export function scopeAllows(
  scopes: string[],
  method: string,
  path: string,
): boolean {
  if (path.split("/").includes("..")) return false;
  if (scopes.includes("*")) return true;
  const upMethod = method.toUpperCase();
  for (const s of scopes) {
    if (s === "*") return true;
    const idx = s.indexOf(":");
    if (idx < 0) continue;
    const m = s.slice(0, idx).toUpperCase();
    const p = s.slice(idx + 1);
    if (m !== "*" && m !== upMethod) continue;
    if (p === "*" || path === p) return true;
    if (path.startsWith(p)) {
      const next = path.charAt(p.length);
      // Boundary: prefix ended at a `/`, or scope's prefix already ends in `/`.
      if (p.endsWith("/") || next === "/") return true;
    }
  }
  return false;
}
