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
  RecentCallsOptions,
  SecretRecord,
  StoreLike,
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

  listTokens(): TokenRecord[] {
    return Object.values(this.read().tokens);
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
    const filtered = opts.tokenId
      ? parsed.filter((e) => e.tokenId === opts.tokenId)
      : parsed;
    return filtered.slice(-opts.limit);
  }
}
