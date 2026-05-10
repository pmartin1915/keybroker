import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
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

interface StoreShape {
  version: 1;
  secrets: Record<string, SecretRecord>;
  tokens: Record<string, TokenRecord>;
}

const EMPTY: StoreShape = { version: 1, secrets: {}, tokens: {} };

/**
 * JSON-backed store. Single-process only — `consumeToken` is atomic
 * within one Node event loop but NOT across processes. Kept for the
 * single-file CLI demo workflow (`--store=json`); SQLite is the default.
 */
export class JsonStore implements StoreLike {
  constructor(
    private readonly path: string,
    private readonly logsPath: string,
    /** When true, refuse all writes. Set after a successful migrate. */
    private readonly readOnly = false,
  ) {}

  private read(): StoreShape {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    const raw = readFileSync(this.path, "utf8");
    if (!raw.trim()) return structuredClone(EMPTY);
    return JSON.parse(raw) as StoreShape;
  }

  private write(state: StoreShape): void {
    if (this.readOnly) {
      throw new Error(
        `JSON store at ${this.path} is read-only (migrated to SQLite).`,
      );
    }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** Apply mutator atomically. NOTE: not safe across processes; single-process locking only. */
  mutate<T>(fn: (state: StoreShape) => T): T {
    const state = this.read();
    const result = fn(state);
    this.write(state);
    return result;
  }

  snapshot(): StoreShape {
    return this.read();
  }

  putSecret(provider: string, rec: SecretRecord): void {
    this.mutate((s) => {
      s.secrets[provider] = rec;
    });
  }

  getSecret(provider: string): SecretRecord | undefined {
    return this.read().secrets[provider];
  }

  listSecrets(): Array<{ provider: string; createdAt: string }> {
    const s = this.read();
    return Object.entries(s.secrets).map(([provider, r]) => ({
      provider,
      createdAt: r.createdAt,
    }));
  }

  putToken(rec: TokenRecord): void {
    this.mutate((s) => {
      s.tokens[rec.id] = rec;
    });
  }

  getToken(id: string): TokenRecord | undefined {
    return this.read().tokens[id];
  }

  listTokens(opts?: ListTokensOptions): TokenRecord[] {
    const all = Object.values(this.read().tokens);
    if (opts?.machine === undefined) return all;
    return all.filter((t) => t.machine === opts.machine);
  }

  consumeToken(id: string): ConsumeResult {
    let outcome: ConsumeResult = "not_found";
    this.mutate((s) => {
      const t = s.tokens[id];
      if (!t) {
        outcome = "not_found";
        return;
      }
      if (t.revoked) {
        outcome = "revoked";
        return;
      }
      if (t.expiresAt && Date.now() / 1000 > t.expiresAt) {
        outcome = "expired";
        return;
      }
      if (t.remaining === 0) {
        outcome = "exhausted";
        return;
      }
      if (t.remaining > 0) t.remaining -= 1;
      t.used += 1;
      outcome = t;
    });
    return outcome;
  }

  revokeToken(id: string): boolean {
    let found = false;
    this.mutate((s) => {
      const t = s.tokens[id];
      if (t) {
        t.revoked = true;
        found = true;
      }
    });
    return found;
  }

  appendCall(entry: CallLogEntry): void {
    appendFileSync(this.logsPath, JSON.stringify(entry) + "\n");
  }

  sumCostUsdByToken(tokenId: string): number {
    if (!existsSync(this.logsPath)) return 0;
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    let total = 0;
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.tokenId !== tokenId) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
      } catch {
        // skip malformed lines — same posture as recentCalls
      }
    }
    return total;
  }

  sumCostUsdSince(ts: string): number {
    if (!existsSync(this.logsPath)) return 0;
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    let total = 0;
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts < ts) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost === "number" && Number.isFinite(cost)) total += cost;
      } catch {
        // skip malformed lines
      }
    }
    return total;
  }

  countCallsSince(ts: string): number {
    if (!existsSync(this.logsPath)) return 0;
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    let count = 0;
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts >= ts) count++;
      } catch {
        // skip malformed lines
      }
    }
    return count;
  }

  sumCostUsdByMachineSince(ts: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (!existsSync(this.logsPath)) return out;
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts < ts) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
        const key = e.machine ?? "";
        out[key] = (out[key] ?? 0) + cost;
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }

  sumCostUsdByTagSince(bucket: TagBucket, ts: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (!existsSync(this.logsPath)) return out;
    const field = tagFieldFor(bucket);
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts < ts) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const tag = e[field];
        if (typeof tag !== "string" || tag.length === 0) continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
        out[tag] = (out[tag] ?? 0) + cost;
      } catch {
        // skip malformed lines — same posture as the other aggregators
      }
    }
    return out;
  }

  topTagsBySpend(
    bucket: TagBucket,
    since: string,
    limit: number,
  ): TagSpendRow[] {
    if (!existsSync(this.logsPath)) return [];
    const field = tagFieldFor(bucket);
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const buckets = new Map<string, { usd: number; callCount: number }>();
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts < since) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const tag = e[field];
        if (typeof tag !== "string" || tag.length === 0) continue;
        const cur = buckets.get(tag) ?? { usd: 0, callCount: 0 };
        cur.callCount += 1;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost === "number" && Number.isFinite(cost)) cur.usd += cost;
        buckets.set(tag, cur);
      } catch {
        // skip malformed lines
      }
    }
    // Mirror SqliteStore's ORDER BY usd DESC, key ASC so the two stores
    // are interchangeable in tests + production. Sort then truncate.
    const rows: TagSpendRow[] = [...buckets.entries()].map(([key, v]) => ({
      key,
      usd: v.usd,
      callCount: v.callCount,
    }));
    rows.sort((a, b) => (b.usd - a.usd) || a.key.localeCompare(b.key));
    return rows.slice(0, limit);
  }

  dailySpendByTokenSince(tokenId: string, ts: string): DailySpendRow[] {
    if (!existsSync(this.logsPath)) return [];
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const buckets = new Map<string, number>();
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.tokenId !== tokenId) continue;
        if (e.ts < ts) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
        // Same `YYYY-MM-DD` extraction as SQLite's substr(ts, 1, 10).
        const day = e.ts.slice(0, 10);
        buckets.set(day, (buckets.get(day) ?? 0) + cost);
      } catch {
        // skip malformed lines
      }
    }
    return [...buckets.entries()]
      .map(([day, usd]) => ({ day, usd }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  dailySpendByTagSince(bucket: TagBucket, ts: string): TagDailySpendRow[] {
    if (!existsSync(this.logsPath)) return [];
    const field = tagFieldFor(bucket);
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    // Map<day, Map<key, usd>>. Two-level grouping mirrors SQLite's
    // `GROUP BY day, tag_X`. Sort posture matches the SQL: day asc,
    // key asc.
    const buckets = new Map<string, Map<string, number>>();
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as CallLogEntry;
        if (e.ts < ts) continue;
        if (e.outcome !== "ok" && e.outcome !== "error") continue;
        const tag = e[field];
        if (typeof tag !== "string" || tag.length === 0) continue;
        const cost = e.actualCostUsd ?? e.estimatedCostUsd;
        if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
        const day = e.ts.slice(0, 10);
        let perKey = buckets.get(day);
        if (!perKey) {
          perKey = new Map<string, number>();
          buckets.set(day, perKey);
        }
        perKey.set(tag, (perKey.get(tag) ?? 0) + cost);
      } catch {
        // skip malformed lines
      }
    }
    const out: TagDailySpendRow[] = [];
    const days = [...buckets.keys()].sort();
    for (const day of days) {
      const perKey = buckets.get(day)!;
      const keys = [...perKey.keys()].sort();
      for (const key of keys) {
        out.push({ day, key, usd: perKey.get(key)! });
      }
    }
    return out;
  }

  recentCalls(opts: RecentCallsOptions): CallLogEntry[] {
    if (!existsSync(this.logsPath)) return [];
    const lines = readFileSync(this.logsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const parsed: CallLogEntry[] = [];
    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l) as CallLogEntry);
      } catch {
        // skip malformed lines
      }
    }
    const filtered = parsed.filter((e) => {
      if (opts.tokenId !== undefined && e.tokenId !== opts.tokenId) return false;
      if (opts.machine !== undefined && e.machine !== opts.machine) return false;
      return true;
    });
    return filtered.slice(-opts.limit);
  }
}

function tagFieldFor(
  bucket: TagBucket,
): "tagTeam" | "tagProject" | "tagEnv" {
  switch (bucket) {
    case "team":
      return "tagTeam";
    case "project":
      return "tagProject";
    case "env":
      return "tagEnv";
  }
}
