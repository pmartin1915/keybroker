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
  /**
   * Phase 2.2: USD cap recorded at issue time. Optional. The broker enforces
   * caps from the JWT `cap` claim, NOT from this column — this is purely for
   * `keybroker token list` display. Keeping the truth in the JWT means a
   * stale TokenRecord (e.g. from a partial restore) cannot loosen
   * enforcement, only mis-display.
   */
  capUsd?: number;
  /**
   * Phase 3.3: tags recorded at issue time. Optional. Same posture as
   * `capUsd` — the broker NEVER reads these for enforcement; they exist
   * so `keybroker tokens` can display attribution and so the CLI's
   * batch operations (3.8) can filter by tag without decoding every
   * JWT. The signed `tag` claim is the source of truth.
   */
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
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
  /**
   * Phase 2.2: return the cumulative USD spend attributable to this token,
   * computed as `actualCostUsd ?? estimatedCostUsd` summed over every
   * audit entry whose outcome is not `denied` (denied calls did not reach
   * upstream, so they have no spend). Returns 0 when no priced calls
   * exist. Used to evaluate per-token caps on the request hot path —
   * keep it cheap (an indexed sum, not a full table scan).
   */
  sumCostUsdByToken(tokenId: string): number;
  /**
   * Phase 3.2: return total USD spend across all tokens since ISO timestamp.
   * Used by the health endpoint for dispatcher integration.
   */
  sumCostUsdSince(ts: string): number;
  /**
   * Phase 3.2: return total call count across all tokens since ISO timestamp.
   * Used by the health endpoint for dispatcher integration.
   */
  countCallsSince(ts: string): number;
  /**
   * Phase 3.2: return USD spend grouped by `machine` since ISO timestamp.
   * Used by the dispatcher to write `keybroker_ok` + per-machine totals
   * into status/health-<machine>.json. Calls without a machine attribution
   * (pre-2.3 records) are bucketed under the empty string ""; the caller
   * decides whether to surface that bucket.
   */
  sumCostUsdByMachineSince(ts: string): Record<string, number>;
  /** Optional close hook (SQLite handle, etc.). */
  close?(): void;
}
