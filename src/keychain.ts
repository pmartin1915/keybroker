import keytar from "keytar";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";

/**
 * Abstraction over the OS credential store. Implementations:
 * - KeytarKeychain (default) — Wincred on Windows, Keychain on macOS,
 *   libsecret on Linux. Uses the `keytar` package.
 * - FileKeychain — JSON file at a given path. Used by tests (so they
 *   don't pollute the real OS credential store) and by the dispatcher
 *   integration where a per-host file is preferable to the shared
 *   user-account keychain.
 * - InMemoryKeychain — process-local map. Useful for unit tests that
 *   don't need to round-trip across CLI subprocesses.
 */
export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<boolean>;
}

export const SERVICE_NAME = "keybroker";

/** Account names used inside the keychain service. */
export const KC_MASTER_KEY = "master_key";
export const KC_JWT_SECRET = "jwt_secret";

export class KeytarKeychain implements Keychain {
  constructor(private readonly service: string = SERVICE_NAME) {}
  async get(account: string): Promise<string | null> {
    return keytar.getPassword(this.service, account);
  }
  async set(account: string, value: string): Promise<void> {
    await keytar.setPassword(this.service, account, value);
  }
  async delete(account: string): Promise<boolean> {
    return keytar.deletePassword(this.service, account);
  }
}

export class InMemoryKeychain implements Keychain {
  private readonly entries = new Map<string, string>();
  async get(account: string): Promise<string | null> {
    return this.entries.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    this.entries.set(account, value);
  }
  async delete(account: string): Promise<boolean> {
    return this.entries.delete(account);
  }
}

/**
 * JSON-file backed keychain. Atomic writes via temp+rename. Mode 0o600.
 * Format: { entries: { [account]: value } }
 *
 * Trade-off vs the OS keychain: secrets sit on disk encrypted only by
 * the filesystem ACL. Acceptable in tests (the path is a tmpdir) and for
 * server contexts where there's no OS user session to bind to. Not the
 * default for interactive CLI use — the OS keychain is stronger.
 */
export class FileKeychain implements Keychain {
  constructor(private readonly path: string) {}

  private readAll(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const raw = readFileSync(this.path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as { entries?: Record<string, string> };
    return parsed.entries ?? {};
  }

  private writeAll(entries: Record<string, string>): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  async get(account: string): Promise<string | null> {
    return this.readAll()[account] ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    const entries = this.readAll();
    entries[account] = value;
    this.writeAll(entries);
  }

  async delete(account: string): Promise<boolean> {
    const entries = this.readAll();
    if (!(account in entries)) return false;
    delete entries[account];
    this.writeAll(entries);
    return true;
  }
}

let _default: Keychain | undefined;

export function getKeychain(): Keychain {
  if (!_default) {
    const filePath = process.env.KEYBROKER_KEYCHAIN_PATH;
    _default = filePath ? new FileKeychain(filePath) : new KeytarKeychain();
  }
  return _default;
}

/** Tests only: swap the global keychain so writes don't touch the real OS store. */
export function setKeychainForTesting(kc: Keychain | undefined): void {
  _default = kc;
}
