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

/** Scope check. Method-prefix ":" path-prefix. "*" = wildcard. */
export function scopeAllows(
  scopes: string[],
  method: string,
  path: string,
): boolean {
  if (scopes.includes("*")) return true;
  for (const s of scopes) {
    if (s === "*") return true;
    const idx = s.indexOf(":");
    if (idx < 0) continue;
    const m = s.slice(0, idx).toUpperCase();
    const p = s.slice(idx + 1);
    if (m !== "*" && m !== method.toUpperCase()) continue;
    if (p === "*" || path === p || path.startsWith(p)) return true;
  }
  return false;
}
