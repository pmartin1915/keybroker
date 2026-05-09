import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { CallLogEntry } from "./logging.js";
import type {
  ConsumeResult,
  RecentCallsOptions,
  SecretRecord,
  StoreLike,
  TokenRecord,
} from "./store-types.js";

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
  revoked INTEGER NOT NULL DEFAULT 0
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
  reason TEXT
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
    consumeAttempt: StatementSync;
    revoke: StatementSync;
    insertCall: StatementSync;
    selectCalls: StatementSync;
    selectCallsByToken: StatementSync;
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
        `INSERT INTO tokens (id, provider, scopes, remaining, used, expires_at, created_at, label, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           scopes = excluded.scopes,
           remaining = excluded.remaining,
           used = excluded.used,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           label = excluded.label,
           revoked = excluded.revoked`,
      ),
      getToken: this.db.prepare(
        `SELECT id, provider, scopes, remaining, used, expires_at, created_at, label, revoked
         FROM tokens WHERE id = ?`,
      ),
      listTokens: this.db.prepare(
        `SELECT id, provider, scopes, remaining, used, expires_at, created_at, label, revoked
         FROM tokens ORDER BY created_at`,
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
           (ts, token_id, label, provider, method, path, status, duration_ms, req_bytes, resp_bytes, outcome, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectCalls: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason
         FROM calls
         ORDER BY id DESC
         LIMIT ?`,
      ),
      selectCallsByToken: this.db.prepare(
        `SELECT ts, token_id, label, provider, method, path, status,
                duration_ms, req_bytes, resp_bytes, outcome, reason
         FROM calls
         WHERE token_id = ?
         ORDER BY id DESC
         LIMIT ?`,
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
    );
  }

  getToken(id: string): TokenRecord | undefined {
    const row = this.stmts.getToken.get(id) as TokenRow | undefined;
    return row ? rowToToken(row) : undefined;
  }

  listTokens(): TokenRecord[] {
    return (this.stmts.listTokens.all() as unknown as TokenRow[]).map(
      rowToToken,
    );
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
    );
  }

  recentCalls(opts: RecentCallsOptions): CallLogEntry[] {
    const rows = (
      opts.tokenId
        ? this.stmts.selectCallsByToken.all(opts.tokenId, opts.limit)
        : this.stmts.selectCalls.all(opts.limit)
    ) as unknown as CallRow[];
    // selectCalls returns DESC for "tail N" semantics; flip back to chronological.
    return rows.reverse().map(rowToCall);
  }

  close(): void {
    this.db.close();
  }
}

function rowToToken(row: TokenRow): TokenRecord {
  return {
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
  return entry;
}
