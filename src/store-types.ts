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
 * Phase 3.4: which tag column to bucket on. Maps to the audit columns
 * `tag_team` / `tag_project` / `tag_env`. The string spelling matches
 * the CLI's `--by` flag and the HTTP `bucket` query parameter — keep
 * them in lockstep.
 */
export type TagBucket = "team" | "project" | "env";

/**
 * Phase 3.4: one row of tag-bucketed spend. `key` is the literal tag
 * value (never empty — untagged calls are filtered out at the store
 * layer; the "Spend by Team" view is a tag-focused query, not a
 * total-spend query). `usd` and `callCount` are scoped to the same
 * `outcome IN ('ok', 'error')` filter as `sumCostUsdSince` so denied
 * calls — which never reached upstream — don't pollute the bucket.
 */
export interface TagSpendRow {
  key: string;
  usd: number;
  callCount: number;
}

/**
 * Phase 3.5: one row of daily spend for a single token. `day` is a
 * `YYYY-MM-DD` UTC date (extracted from `ts`'s ISO prefix). `usd` is
 * the day's incremental priced spend — the forecast layer cumsums to
 * get the regression series. Sparse: only days with priced ok/error
 * spend appear.
 */
export interface DailySpendRow {
  day: string;
  usd: number;
}

/**
 * Phase 3.5: one row of daily spend for a single (tag, day) pair.
 * Same UTC-date convention as `DailySpendRow`. Sparse — untagged
 * calls and zero-spend days are omitted.
 */
export interface TagDailySpendRow {
  day: string;
  key: string;
  usd: number;
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
  /**
   * Phase 3.4: USD spend grouped by tag value for a single tag bucket
   * since ISO timestamp. Untagged calls (NULL tag column) are excluded
   * — tag aggregation is opt-in and a phantom "" bucket would dominate
   * any project that hasn't fully rolled out tagging. Denied calls are
   * excluded for the same reason as `sumCostUsdSince`.
   */
  sumCostUsdByTagSince(bucket: TagBucket, ts: string): Record<string, number>;
  /**
   * Phase 3.4: ranked tag-bucket spend for the dashboard / CLI. Same
   * filter posture as `sumCostUsdByTagSince` (untagged + denied
   * excluded) but ordered by spend descending and capped by `limit`.
   * Ties broken alphabetically by `key` so successive calls with the
   * same data return a stable order — load-bearing for snapshot tests
   * and for any UI that diff-renders the leaderboard.
   */
  topTagsBySpend(
    bucket: TagBucket,
    since: string,
    limit: number,
  ): TagSpendRow[];
  /**
   * Phase 3.5: per-day priced spend for a single token since `ts`.
   * Returns sparse `{day, usd}` ordered by day ascending. Only `ok` /
   * `error` outcomes contribute (denied calls never reached upstream
   * — same posture as `sumCostUsdSince`). Days with zero priced spend
   * are absent; the forecast layer densifies via
   * `buildDenseCumulativeSeries`.
   */
  dailySpendByTokenSince(tokenId: string, ts: string): DailySpendRow[];
  /**
   * Phase 3.5: per-day priced spend per tag value, for a single bucket
   * since `ts`. Returns sparse `{day, key, usd}` ordered by day asc,
   * key asc. Untagged calls excluded for the same reason as
   * `sumCostUsdByTagSince` (a phantom "" bucket would dominate).
   */
  dailySpendByTagSince(bucket: TagBucket, ts: string): TagDailySpendRow[];
  /** Optional close hook (SQLite handle, etc.). */
  close?(): void;
}
