import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { CallLogEntry } from "./logging.js";
import type {
  ConsumeResult,
  DailySpendRow,
  ListTokensOptions,
  RecentCallsOptions,
  SecretRecord,
  StoreLike,
  TagBucket,
  TagDailySpendRow,
  TagSpendRow,
  TokenRecord,
} from "./store-types.js";

// Phase 3.4: tag-bucket SQL is keyed by `TagBucket` via three pairs of
// prepared statements (sum + top, one per bucket). The dispatch lives
// in `tagSumStmt` / `tagTopStmt` rather than dynamic SQL on purpose —
// `bucket` is reachable from the HTTP layer, and any path that builds
// a SQL fragment from request input is exactly the kind of thing that
// turns into table drops. The closed type set is the safety boundary.

interface TokenRow {
  id: string;
  provider: string;
  scopes: string;
  remaining: number;
  used: number;
  expires_at: number;
  created_at: string;
  label: string;
  revoked: number;
  machine: string | null;
  cap_usd: number | null;
  tag_team: string | null;
  tag_project: string | null;
  tag_env: string | null;
}

interface SecretRow {
  provider: string;
  ciphertext: string;
  created_at: string;
}

interface CallRow {
  ts: string;
  token_id: string;
  label: string;
  provider: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  req_bytes: number;
  resp_bytes: number;
  outcome: string;
  reason: string | null;
  requested_model: string | null;
  machine: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  tag_team: string | null;
  tag_project: string | null;
  tag_env: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS secrets (
  provider TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  scopes TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'unlabeled',
  revoked INTEGER NOT NULL DEFAULT 0,
  machine TEXT,
  cap_usd REAL,
  tag_team TEXT,
  tag_project TEXT,
  tag_env TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  token_id TEXT NOT NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  req_bytes INTEGER NOT NULL,
  resp_bytes INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  requested_model TEXT,
  machine TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  tag_team TEXT,
  tag_project TEXT,
  tag_env TEXT
);

CREATE INDEX IF NOT EXISTS calls_token_id_idx ON calls(token_id);
CREATE INDEX IF NOT EXISTS calls_ts_idx ON calls(ts);
`;

/**
 * SQLite-backed store. Atomic across processes via SQLite's file lock.
 * Uses WAL journaling so readers don't block writers.
 */
export class SqliteStore implements StoreLike {
  private readonly db: DatabaseSync;
  private readonly stmts: {
    putSecret: StatementSync;
    getSecret: StatementSync;
    listSecrets: StatementSync;
    putToken: StatementSync;
    getToken: StatementSync;
    listTokens: StatementSync;
    listTokensByMachine: StatementSync;
    consumeAttempt: StatementSync;
    revoke: StatementSync;
    insertCall: StatementSync;
    selectCalls: StatementSync;
    selectCallsByToken: StatementSync;
    selectCallsByMachine: StatementSync;
    selectCallsByTokenAndMachine: StatementSync;
    sumCostByToken: StatementSync;
    sumCostSince: StatementSync;
    countCallsSince: StatementSync;
    sumCostByMachineSince: StatementSync;
    sumCostByTagTeamSince: StatementSync;
    sumCostByTagProjectSince: StatementSync;
    sumCostByTagEnvSince: StatementSync;
    topTagTeamBySpend: StatementSync;
    topTagProjectBySpend: StatementSync;
    topTagEnvBySpend: StatementSync;
    dailySpendByTokenSince: StatementSync;
    dailySpendByTagTeamSince: StatementSync;
    dailySpendByTagProjectSince: StatementSync;
    dailySpendByTagEnvSince: StatementSync;
  };

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // busy_timeout MUST come before any pragma that takes the write lock —
    // setting it later means concurrent openers race and crash on the WAL
    // upgrade ("database is locked" with no retry).
    this.db.exec("PRAGMA busy_timeout = 5000");
    // Switch to WAL only if not already WAL — re-setting takes the write
    // lock unnecessarily and adds to startup contention.
    const mode = this.db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (mode?.journal_mode?.toLowerCase() !== "wal") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    // NORMAL is safe with WAL and faster than FULL.
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA);
    // Idempotent migrations for stores that pre-date a column. SQLite's
    // ALTER TABLE ADD COLUMN is cheap (no table rewrite), but we guard with
    // PRAGMA table_info so re-runs are no-ops on schemas already at head.
    this.migrate(this.db);
    this.stmts = {
      putSecret: this.db.prepare(
        `INSERT INTO secrets (provider, ciphertext, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           created_at = excluded.created_at`,
      ),
      getSecret: this.db.prepare(
        `SELECT provider, ciphertext, created_at FROM secrets WHERE provider = ?`,
      ),
      listSecrets: this.db.prepare(
        `SELECT provider, created_at FROM secrets ORDER BY provider`,
      ),
      putToken: this.db.prepare(
        `INSERT INTO tokens (id, provider, scopes, remaining, used, expires_at, created_at, label, revoked, machine, cap_usd, tag_team, tag_project, tag_env)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           scopes = excluded.scopes,
           remaining = excluded.remaining,
           used = excluded.used,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           label = excluded.label,
           revoked = excluded.revoked,
           machine = excluded.machine,
           cap_usd = excluded.cap_usd,
           tag_team = excluded.tag_team,
           tag_project = excluded.tag_project,
           tag_env = excluded.tag_env`,
      ),
      getToken: this.db.prepare(
        `SELECT id, provider, scopes, remaining, used, expires_at, created_at, label, revoked, machine, cap_usd, tag_team, tag_project, tag_env
         FROM tokens WHERE id = ?`,
      ),
      listTokens: this.db.prepare(
        `SELECT id, provider, scopes, remaining, used, expires_at, created_at, label, revoked, machine, cap_usd, tag_team, tag_project, tag_env
         FROM tokens ORDER BY created_at`,
      ),
      listTokensByMachine: this.db.prepare(
        `SELECT id, provider, scopes, remaining, used, expires_at, created_at, label, revoked, machine, cap_usd, tag_team, tag_project, tag_env
         FROM tokens WHERE machine = ? ORDER BY created_at`,
      ),
      // Single-statement atomic check-and-decrement. Returns 1 row updated
      // iff the token is consumable. We then read it back to return the
      // updated TokenRecord. The CASE expression preserves remaining = -1
      // (unlimited) without decrementing.
      consumeAttempt: this.db.prepare(
        `UPDATE tokens
         SET remaining = CASE WHEN remaining > 0 THEN remaining - 1 ELSE remaining END,
             used = used + 1
         WHERE id = ?
           AND revoked = 0
           AND (expires_at = 0 OR expires_at > ?)
           AND (remaining = -1 OR remaining > 0)`,
      ),
      revoke: this.db.prepare(`UPDATE tokens SET revoked = 1 WHERE id = ?`),
      insertCall: this.db.prepare(
        `INSERT INTO calls
           (ts, token_id, label, provider, method, path, status, duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine, estimated_cost_usd, actual_cost_usd, tag_team, tag_project, tag_env)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectCalls: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine,
                estimated_cost_usd, actual_cost_usd, tag_team, tag_project, tag_env
         FROM calls
         ORDER BY id DESC
         LIMIT ?`,
      ),
      selectCallsByToken: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine,
                estimated_cost_usd, actual_cost_usd, tag_team, tag_project, tag_env
         FROM calls
         WHERE token_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      ),
      selectCallsByMachine: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine,
                estimated_cost_usd, actual_cost_usd, tag_team, tag_project, tag_env
         FROM calls
         WHERE machine = ?
         ORDER BY id DESC
         LIMIT ?`,
      ),
      selectCallsByTokenAndMachine: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason, requested_model, machine,
                estimated_cost_usd, actual_cost_usd, tag_team, tag_project, tag_env
         FROM calls
         WHERE token_id = ? AND machine = ?
         ORDER BY id DESC
         LIMIT ?`,
      ),
      // Phase 2.2: cumulative spend per token. SUM treats rows whose cost
      // columns are both NULL as 0, which matches "unpriced model → contributes
      // nothing". COALESCE picks the actual cost first, falling back to the
      // estimate so an in-flight call with no upstream usage yet still
      // counts against the cap. Outcomes are explicitly allowlisted so a
      // future "did-not-reach-upstream" outcome (e.g. a hypothetical
      // `rate_limited`) doesn't silently get billed — adding such an
      // outcome would force whoever does it to update this query
      // deliberately, instead of relying on a string deny-list match
      // that would coerce them to zero billing.
      sumCostByToken: this.db.prepare(
        `SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE token_id = ? AND outcome IN ('ok', 'error')`,
      ),
      sumCostSince: this.db.prepare(
        `SELECT COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error')`,
      ),
      countCallsSince: this.db.prepare(
        `SELECT COUNT(*) AS total
         FROM calls
         WHERE ts >= ?`,
      ),
      // Phase 3.2: spend grouped by machine. COALESCE(machine, '') buckets
      // pre-2.3 calls under "" so the caller sees them rather than silently
      // dropping. Outcome filter mirrors sumCostByToken — denied calls
      // never reached upstream and have no spend.
      sumCostByMachineSince: this.db.prepare(
        `SELECT COALESCE(machine, '') AS machine,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error')
         GROUP BY COALESCE(machine, '')`,
      ),
      // Phase 3.4: tag-bucketed aggregations. One prepared statement per
      // column rather than dynamic SQL — SqliteStore prepares everything
      // in the constructor and `tag_team` / `tag_project` / `tag_env`
      // are the closed set of buckets. The `IS NOT NULL` filter excludes
      // untagged calls so tag-focused dashboards don't get dominated by
      // a phantom NULL bucket; use sumCostUsdSince for the total. Denied
      // outcome filter mirrors every other spend query.
      sumCostByTagTeamSince: this.db.prepare(
        `SELECT tag_team AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_team IS NOT NULL
         GROUP BY tag_team`,
      ),
      sumCostByTagProjectSince: this.db.prepare(
        `SELECT tag_project AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_project IS NOT NULL
         GROUP BY tag_project`,
      ),
      sumCostByTagEnvSince: this.db.prepare(
        `SELECT tag_env AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS total
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_env IS NOT NULL
         GROUP BY tag_env`,
      ),
      // ORDER BY usd DESC, key ASC: the alphabetic tiebreak makes the
      // leaderboard deterministic when two buckets have identical spend
      // (common in tests, possible in low-traffic prod). Without it,
      // SQLite's GROUP BY order is unspecified and snapshot tests would
      // flake. callCount is COUNT over the same filter — a tagged call
      // with no priced cost still counts as activity.
      topTagTeamBySpend: this.db.prepare(
        `SELECT tag_team AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS usd,
                COUNT(*) AS call_count
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_team IS NOT NULL
         GROUP BY tag_team
         ORDER BY usd DESC, key ASC
         LIMIT ?`,
      ),
      topTagProjectBySpend: this.db.prepare(
        `SELECT tag_project AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS usd,
                COUNT(*) AS call_count
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_project IS NOT NULL
         GROUP BY tag_project
         ORDER BY usd DESC, key ASC
         LIMIT ?`,
      ),
      topTagEnvBySpend: this.db.prepare(
        `SELECT tag_env AS key,
                COALESCE(SUM(COALESCE(actual_cost_usd, estimated_cost_usd)), 0) AS usd,
                COUNT(*) AS call_count
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_env IS NOT NULL
         GROUP BY tag_env
         ORDER BY usd DESC, key ASC
         LIMIT ?`,
      ),
      // Phase 3.5: per-day spend for a single token. substr(ts, 1, 10)
      // pulls the YYYY-MM-DD prefix off the ISO timestamp — every
      // appendCall stores `new Date().toISOString()` so the prefix is
      // a stable UTC date. Sparse output: the row-level
      // `cost IS NOT NULL` filter drops days that contain only
      // unpriced calls, matching the JSON store's `cost is finite`
      // check (so both backends emit the same sparse series). The
      // forecast layer cumsums and densifies via
      // `buildDenseCumulativeSeries`; days dropped here just become
      // 0-increment cells in the dense series. Same outcome filter as
      // sumCostByToken — denied calls are never billed.
      dailySpendByTokenSince: this.db.prepare(
        `SELECT substr(ts, 1, 10) AS day,
                SUM(COALESCE(actual_cost_usd, estimated_cost_usd)) AS usd
         FROM calls
         WHERE token_id = ? AND ts >= ? AND outcome IN ('ok', 'error')
           AND COALESCE(actual_cost_usd, estimated_cost_usd) IS NOT NULL
         GROUP BY day
         ORDER BY day ASC`,
      ),
      // Phase 3.5: per-day spend per tag value, one row per (day, tag).
      // Same `IS NOT NULL` posture as the bucket aggregations — untagged
      // calls don't pollute the per-tag forecast. Ordered by day asc
      // then key asc so the JSON store can mirror SQLite output exactly.
      // Row-level cost-not-null filter mirrors dailySpendByTokenSince.
      dailySpendByTagTeamSince: this.db.prepare(
        `SELECT substr(ts, 1, 10) AS day,
                tag_team AS key,
                SUM(COALESCE(actual_cost_usd, estimated_cost_usd)) AS usd
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_team IS NOT NULL
           AND COALESCE(actual_cost_usd, estimated_cost_usd) IS NOT NULL
         GROUP BY day, tag_team
         ORDER BY day ASC, key ASC`,
      ),
      dailySpendByTagProjectSince: this.db.prepare(
        `SELECT substr(ts, 1, 10) AS day,
                tag_project AS key,
                SUM(COALESCE(actual_cost_usd, estimated_cost_usd)) AS usd
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_project IS NOT NULL
           AND COALESCE(actual_cost_usd, estimated_cost_usd) IS NOT NULL
         GROUP BY day, tag_project
         ORDER BY day ASC, key ASC`,
      ),
      dailySpendByTagEnvSince: this.db.prepare(
        `SELECT substr(ts, 1, 10) AS day,
                tag_env AS key,
                SUM(COALESCE(actual_cost_usd, estimated_cost_usd)) AS usd
         FROM calls
         WHERE ts >= ? AND outcome IN ('ok', 'error') AND tag_env IS NOT NULL
           AND COALESCE(actual_cost_usd, estimated_cost_usd) IS NOT NULL
         GROUP BY day, tag_env
         ORDER BY day ASC, key ASC`,
      ),
    };
  }

  putSecret(provider: string, rec: SecretRecord): void {
    this.stmts.putSecret.run(provider, rec.ciphertext, rec.createdAt);
  }

  getSecret(provider: string): SecretRecord | undefined {
    const row = this.stmts.getSecret.get(provider) as SecretRow | undefined;
    if (!row) return undefined;
    return {
      provider: row.provider,
      ciphertext: row.ciphertext,
      createdAt: row.created_at,
    };
  }

  listSecrets(): Array<{ provider: string; createdAt: string }> {
    const rows = this.stmts.listSecrets.all() as Array<{
      provider: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ provider: r.provider, createdAt: r.created_at }));
  }

  putToken(rec: TokenRecord): void {
    this.stmts.putToken.run(
      rec.id,
      rec.provider,
      JSON.stringify(rec.scopes),
      rec.remaining,
      rec.used,
      rec.expiresAt,
      rec.createdAt,
      rec.label,
      rec.revoked ? 1 : 0,
      rec.machine ?? null,
      rec.capUsd ?? null,
      rec.tagTeam ?? null,
      rec.tagProject ?? null,
      rec.tagEnv ?? null,
    );
  }

  getToken(id: string): TokenRecord | undefined {
    const row = this.stmts.getToken.get(id) as TokenRow | undefined;
    return row ? rowToToken(row) : undefined;
  }

  listTokens(opts?: ListTokensOptions): TokenRecord[] {
    const rows = (
      opts?.machine !== undefined
        ? this.stmts.listTokensByMachine.all(opts.machine)
        : this.stmts.listTokens.all()
    ) as unknown as TokenRow[];
    return rows.map(rowToToken);
  }

  consumeToken(id: string): ConsumeResult {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const result = this.stmts.consumeAttempt.run(id, nowEpoch);
    if (result.changes === 1) {
      const updated = this.getToken(id);
      // The UPDATE just succeeded, so the row must exist.
      return updated ?? "not_found";
    }
    // No update — figure out why. We re-read to discriminate. Worst case
    // the token's state changed between the failed UPDATE and this SELECT;
    // that's fine, the proxy will retry on the next request.
    const t = this.getToken(id);
    if (!t) return "not_found";
    if (t.revoked) return "revoked";
    if (t.expiresAt && Date.now() / 1000 > t.expiresAt) return "expired";
    if (t.remaining === 0) return "exhausted";
    // Race: token became consumable again between UPDATE and SELECT (e.g.
    // a peer call completed and bumped remaining). Treat as exhausted; the
    // caller will retry on next request.
    return "exhausted";
  }

  revokeToken(id: string): boolean {
    const r = this.stmts.revoke.run(id);
    return r.changes > 0;
  }

  appendCall(entry: CallLogEntry): void {
    this.stmts.insertCall.run(
      entry.ts,
      entry.tokenId,
      entry.label,
      entry.provider,
      entry.method,
      entry.path,
      entry.status,
      entry.durationMs,
      entry.reqBytes,
      entry.respBytes,
      entry.outcome,
      entry.reason ?? null,
      entry.requestedModel ?? null,
      entry.machine ?? null,
      entry.estimatedCostUsd ?? null,
      entry.actualCostUsd ?? null,
      entry.tagTeam ?? null,
      entry.tagProject ?? null,
      entry.tagEnv ?? null,
    );
  }

  sumCostUsdByToken(tokenId: string): number {
    const row = this.stmts.sumCostByToken.get(tokenId) as
      | { total: number | null }
      | undefined;
    return row?.total ?? 0;
  }

  sumCostUsdSince(ts: string): number {
    const row = this.stmts.sumCostSince.get(ts) as
      | { total: number | null }
      | undefined;
    return row?.total ?? 0;
  }

  countCallsSince(ts: string): number {
    const row = this.stmts.countCallsSince.get(ts) as
      | { total: number | null }
      | undefined;
    return row?.total ?? 0;
  }

  sumCostUsdByMachineSince(ts: string): Record<string, number> {
    const rows = this.stmts.sumCostByMachineSince.all(ts) as Array<{
      machine: string;
      total: number | null;
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.machine] = r.total ?? 0;
    return out;
  }

  sumCostUsdByTagSince(bucket: TagBucket, ts: string): Record<string, number> {
    const stmt = this.tagSumStmt(bucket);
    const rows = stmt.all(ts) as Array<{
      key: string;
      total: number | null;
    }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.key] = r.total ?? 0;
    return out;
  }

  topTagsBySpend(
    bucket: TagBucket,
    since: string,
    limit: number,
  ): TagSpendRow[] {
    const stmt = this.tagTopStmt(bucket);
    const rows = stmt.all(since, limit) as Array<{
      key: string;
      usd: number | null;
      call_count: number;
    }>;
    return rows.map((r) => ({
      key: r.key,
      usd: r.usd ?? 0,
      callCount: r.call_count,
    }));
  }

  dailySpendByTokenSince(tokenId: string, ts: string): DailySpendRow[] {
    const rows = this.stmts.dailySpendByTokenSince.all(tokenId, ts) as Array<{
      day: string;
      usd: number | null;
    }>;
    return rows.map((r) => ({ day: r.day, usd: r.usd ?? 0 }));
  }

  dailySpendByTagSince(bucket: TagBucket, ts: string): TagDailySpendRow[] {
    const stmt = this.tagDailyStmt(bucket);
    const rows = stmt.all(ts) as Array<{
      day: string;
      key: string;
      usd: number | null;
    }>;
    return rows.map((r) => ({ day: r.day, key: r.key, usd: r.usd ?? 0 }));
  }

  private tagDailyStmt(bucket: TagBucket): StatementSync {
    switch (bucket) {
      case "team":
        return this.stmts.dailySpendByTagTeamSince;
      case "project":
        return this.stmts.dailySpendByTagProjectSince;
      case "env":
        return this.stmts.dailySpendByTagEnvSince;
    }
  }

  private tagSumStmt(bucket: TagBucket): StatementSync {
    switch (bucket) {
      case "team":
        return this.stmts.sumCostByTagTeamSince;
      case "project":
        return this.stmts.sumCostByTagProjectSince;
      case "env":
        return this.stmts.sumCostByTagEnvSince;
    }
  }

  private tagTopStmt(bucket: TagBucket): StatementSync {
    switch (bucket) {
      case "team":
        return this.stmts.topTagTeamBySpend;
      case "project":
        return this.stmts.topTagProjectBySpend;
      case "env":
        return this.stmts.topTagEnvBySpend;
    }
  }

  private migrate(db: DatabaseSync): void {
    // Same idempotent ALTER pattern as the Phase 2.1 `requested_model`
    // migration: each missing column is ALTERed individually so a
    // partially-migrated DB recovers, and the duplicate-column race
    // between concurrent openers is swallowed.
    addColumnIfMissing(db, "calls", "requested_model", "TEXT");
    addColumnIfMissing(db, "calls", "machine", "TEXT");
    addColumnIfMissing(db, "tokens", "machine", "TEXT");
    // Phase 2.2: USD cost columns. REAL because dollar amounts have decimals
    // and SUM() over INTEGER would lose cents on multi-call accounting.
    addColumnIfMissing(db, "calls", "estimated_cost_usd", "REAL");
    addColumnIfMissing(db, "calls", "actual_cost_usd", "REAL");
    addColumnIfMissing(db, "tokens", "cap_usd", "REAL");
    // Phase 3.3: tag attribution columns. Mirror calls/tokens — same
    // posture as machine: never read for enforcement, only for display
    // (tokens) and aggregation (calls).
    addColumnIfMissing(db, "tokens", "tag_team", "TEXT");
    addColumnIfMissing(db, "tokens", "tag_project", "TEXT");
    addColumnIfMissing(db, "tokens", "tag_env", "TEXT");
    addColumnIfMissing(db, "calls", "tag_team", "TEXT");
    addColumnIfMissing(db, "calls", "tag_project", "TEXT");
    addColumnIfMissing(db, "calls", "tag_env", "TEXT");
    // Indexes for the Phase 2.3 filters. Created post-ALTER so the
    // referenced columns are guaranteed to exist on pre-2.3 DBs that
    // have just been migrated.
    db.exec("CREATE INDEX IF NOT EXISTS calls_machine_idx ON calls(machine)");
    // Composite index for the combined `--token <id> --machine <name>` log
    // filter (selectCallsByTokenAndMachine). Without it, SQLite would pick
    // one single-column index and table-scan the rest of the predicate.
    db.exec(
      "CREATE INDEX IF NOT EXISTS calls_token_machine_idx ON calls(token_id, machine)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS tokens_machine_idx ON tokens(machine)");
    // Phase 3.4: partial indexes for the tag-bucketed spend queries. Each
    // tag is sparse (most calls untagged in early rollout), and the
    // queries already filter `IS NOT NULL`, so a partial index on the
    // non-null subset stays small and avoids indexing the long tail of
    // untagged rows. `(ts, tag_X)` puts the time-range filter first,
    // matching the access pattern of `WHERE ts >= ? AND tag_X IS NOT
    // NULL GROUP BY tag_X`.
    db.exec(
      "CREATE INDEX IF NOT EXISTS calls_tag_team_ts_idx ON calls(ts, tag_team) WHERE tag_team IS NOT NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS calls_tag_project_ts_idx ON calls(ts, tag_project) WHERE tag_project IS NOT NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS calls_tag_env_ts_idx ON calls(ts, tag_env) WHERE tag_env IS NOT NULL",
    );
  }

  recentCalls(opts: RecentCallsOptions): CallLogEntry[] {
    let rows: CallRow[];
    if (opts.tokenId !== undefined && opts.machine !== undefined) {
      rows = this.stmts.selectCallsByTokenAndMachine.all(
        opts.tokenId,
        opts.machine,
        opts.limit,
      ) as unknown as CallRow[];
    } else if (opts.tokenId !== undefined) {
      rows = this.stmts.selectCallsByToken.all(
        opts.tokenId,
        opts.limit,
      ) as unknown as CallRow[];
    } else if (opts.machine !== undefined) {
      rows = this.stmts.selectCallsByMachine.all(
        opts.machine,
        opts.limit,
      ) as unknown as CallRow[];
    } else {
      rows = this.stmts.selectCalls.all(opts.limit) as unknown as CallRow[];
    }
    // selectCalls returns DESC for "tail N" semantics; flip back to chronological.
    return rows.reverse().map(rowToCall);
  }

  close(): void {
    this.db.close();
  }
}

function rowToToken(row: TokenRow): TokenRecord {
  const rec: TokenRecord = {
    id: row.id,
    provider: row.provider,
    scopes: JSON.parse(row.scopes) as string[],
    remaining: row.remaining,
    used: row.used,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    label: row.label,
    revoked: row.revoked === 1,
  };
  if (row.machine !== null) rec.machine = row.machine;
  if (row.cap_usd !== null) rec.capUsd = row.cap_usd;
  if (row.tag_team !== null) rec.tagTeam = row.tag_team;
  if (row.tag_project !== null) rec.tagProject = row.tag_project;
  if (row.tag_env !== null) rec.tagEnv = row.tag_env;
  return rec;
}

function rowToCall(row: CallRow): CallLogEntry {
  const entry: CallLogEntry = {
    ts: row.ts,
    tokenId: row.token_id,
    label: row.label,
    provider: row.provider,
    method: row.method,
    path: row.path,
    status: row.status,
    durationMs: row.duration_ms,
    reqBytes: row.req_bytes,
    respBytes: row.resp_bytes,
    outcome: row.outcome as CallLogEntry["outcome"],
  };
  if (row.reason !== null) entry.reason = row.reason;
  if (row.requested_model !== null) entry.requestedModel = row.requested_model;
  if (row.machine !== null) entry.machine = row.machine;
  if (row.estimated_cost_usd !== null) entry.estimatedCostUsd = row.estimated_cost_usd;
  if (row.actual_cost_usd !== null) entry.actualCostUsd = row.actual_cost_usd;
  if (row.tag_team !== null) entry.tagTeam = row.tag_team;
  if (row.tag_project !== null) entry.tagProject = row.tag_project;
  if (row.tag_env !== null) entry.tagEnv = row.tag_env;
  return entry;
}

function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  const have = new Set(cols.map((c) => c.name));
  if (have.has(column)) return;
  // Race with concurrent openers: two processes can both observe the
  // column missing, both attempt ALTER, and the loser sees "duplicate
  // column name". That's a benign race — the column exists either way
  // — so swallow it. Re-throw anything else, including a different
  // error message ("duplicate column" wording could change in node:sqlite).
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (!/duplicate column name/i.test(msg)) throw e;
  }
}
