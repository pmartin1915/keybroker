import type { CallLogEntry } from "./logging.js";

export interface SecretRecord {
  /** Provider key, e.g. "openai". Must match a registered provider. */
  provider: string;
  /** Encrypted upstream API key (base64). */
  ciphertext: string;
  createdAt: string;
}

export interface TokenRecord {
  /** Unique token identifier (jti). */
  id: string;
  /** Which provider this token may proxy to. */
  provider: string;
  /** Allowed methods + path prefixes, e.g. ["POST:/v1/chat/completions"]. ["*"] = unrestricted. */
  scopes: string[];
  /** Remaining allowed calls. -1 = unlimited. */
  remaining: number;
  /** Total calls made (for stats only). */
  used: number;
  /** Unix epoch seconds. 0 = no expiry. */
  expiresAt: number;
  createdAt: string;
  /** Free-form label so you can find tokens in logs. */
  label: string;
  revoked: boolean;
  /**
   * Phase 2.3: machine the token was issued from (typically `os.hostname()`
   * at issue time). Optional so pre-2.3 records remain valid. Stored on the
   * record so `keybroker tokens --machine` and `revoke-all --machine` can
   * filter without decoding every JWT.
   */
  machine?: string;
}

export type ConsumeResult =
  | TokenRecord
  | "not_found"
  | "revoked"
  | "expired"
  | "exhausted";

export interface RecentCallsOptions {
  limit: number;
  tokenId?: string;
  /** Phase 2.3: filter by `machine` audit column. */
  machine?: string;
}

/** Phase 2.3: filter for `listTokens`. Empty/missing = no filter. */
export interface ListTokensOptions {
  /** Restrict to tokens issued from this machine. */
  machine?: string;
}

/**
 * Storage interface implemented by JsonStore (legacy) and SqliteStore (default).
 * `consumeToken` MUST be atomic across concurrent processes.
 */
export interface StoreLike {
  // secrets
  putSecret(provider: string, rec: SecretRecord): void;
  getSecret(provider: string): SecretRecord | undefined;
  listSecrets(): Array<{ provider: string; createdAt: string }>;
  // tokens
  putToken(rec: TokenRecord): void;
  getToken(id: string): TokenRecord | undefined;
  listTokens(opts?: ListTokensOptions): TokenRecord[];
  /** Atomic check-and-decrement. */
  consumeToken(id: string): ConsumeResult;
  revokeToken(id: string): boolean;
  // calls (audit trail)
  appendCall(entry: CallLogEntry): void;
  recentCalls(opts: RecentCallsOptions): CallLogEntry[];
  /** Optional close hook (SQLite handle, etc.). */
  close?(): void;
}
