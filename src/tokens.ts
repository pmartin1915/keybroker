import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface BrokerClaims extends JWTPayload {
  /** Provider this token may access. */
  prv: string;
  /** Allowed scopes, e.g. ["POST:/v1/chat/completions"]. */
  scp: string[];
  /** Free-form label for audit. */
  lbl: string;
}

export const TOKEN_PREFIX = "brk_";

export async function issueToken(
  secret: string,
  args: {
    tokenId: string;
    provider: string;
    scopes: string[];
    label: string;
    /** Seconds until expiry. 0 = no expiry. */
    ttlSeconds: number;
  },
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  const builder = new SignJWT({
    prv: args.provider,
    scp: args.scopes,
    lbl: args.label,
  })
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
