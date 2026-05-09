import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

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
}

interface StoreShape {
  version: 1;
  secrets: Record<string, SecretRecord>;
  tokens: Record<string, TokenRecord>;
}

const EMPTY: StoreShape = { version: 1, secrets: {}, tokens: {} };

export class Store {
  constructor(private readonly path: string) {}

  private read(): StoreShape {
    if (!existsSync(this.path)) return structuredClone(EMPTY);
    const raw = readFileSync(this.path, "utf8");
    if (!raw.trim()) return structuredClone(EMPTY);
    return JSON.parse(raw) as StoreShape;
  }

  private write(state: StoreShape): void {
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

  /** Atomically check-and-decrement. Returns the updated record on success, or a string error code. */
  consumeToken(id: string): TokenRecord | "not_found" | "revoked" | "expired" | "exhausted" {
    let outcome: TokenRecord | "not_found" | "revoked" | "expired" | "exhausted" =
      "not_found";
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
}

export function newTokenId(): string {
  return randomUUID();
}
