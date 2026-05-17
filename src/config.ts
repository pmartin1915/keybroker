import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import {
  getKeychain,
  KC_JWT_SECRET,
  KC_MASTER_KEY,
  KC_MGMT_SECRET,
  type Keychain,
} from "./keychain.js";
import { generateJwtSecret } from "./crypto.js";

export interface BrokerConfig {
  dataDir: string;
  /** Legacy JSON store. Used only when --store=json or during migration. */
  jsonStorePath: string;
  /** SQLite store (default backend). */
  sqliteStorePath: string;
  /** Append-only call log used by the JSON store. SQLite store keeps calls in-db. */
  logsPath: string;
  configPath: string;
  /** Phase 2.4 fleet policy file (forbidden_models, allowed_providers). Optional on disk. */
  policyPath: string;
  port: number;
  host: string;
  /** Hex-encoded 32-byte master key for AES-256-GCM at-rest encryption. */
  masterKeyHex: string;
  /** Symmetric secret used to sign/verify JWT tokens. */
  jwtSecret: string;
  /**
   * Phase 4.0 c4: symmetric secret used to sign/verify *management*
   * JWTs (the ones that authorize POST/DELETE on /admin/*). Distinct
   * from `jwtSecret` so the read/proxy axis and the write/admin axis
   * have independent blast radii. Lazy-generated on first load if
   * the keychain has no entry yet — see `loadConfig`.
   */
  mgmtSecret: string;
}

const DEFAULT_DATA_DIR =
  process.env.KEYBROKER_HOME ?? join(homedir(), ".keybroker");

export function dataDir(): string {
  return DEFAULT_DATA_DIR;
}

export function ensureDataDir(): string {
  if (!existsSync(DEFAULT_DATA_DIR)) {
    mkdirSync(DEFAULT_DATA_DIR, { recursive: true });
  }
  return DEFAULT_DATA_DIR;
}

/**
 * On-disk config. Post-Phase-1.3 secrets live in the OS keychain, so the
 * config file holds only network settings and a marker. The legacy fields
 * (`masterKeyHex`/`jwtSecret`) are read for back-compat and trigger an
 * upgrade hint, but new installs should never write them.
 */
interface OnDiskConfig {
  port?: number;
  host?: string;
  /** @deprecated stored in OS keychain since Phase 1.3 */
  masterKeyHex?: string;
  /** @deprecated stored in OS keychain since Phase 1.3 */
  jwtSecret?: string;
  /** Optional: identifies the keychain entry, useful when running multiple brokers on one machine. */
  keychainService?: string;
}

export interface LoadConfigOptions {
  /** Override the keychain (tests). */
  keychain?: Keychain;
}

export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<BrokerConfig> {
  const dir = ensureDataDir();
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `keybroker not initialized. Run \`keybroker init\` first (looked in ${dir}).`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as OnDiskConfig;
  const kc = opts.keychain ?? getKeychain();

  let masterKeyHex = await kc.get(KC_MASTER_KEY);
  let jwtSecret = await kc.get(KC_JWT_SECRET);
  let mgmtSecret = await kc.get(KC_MGMT_SECRET);

  // Back-compat: legacy installs (Phase ≤1.2) kept secrets in config.json.
  // Read them, warn, and prompt for migration. Don't auto-write to the
  // keychain — the user should be aware of the move.
  if ((!masterKeyHex || !jwtSecret) && (raw.masterKeyHex || raw.jwtSecret)) {
    console.warn(
      `keybroker: secrets are still in ${configPath}. ` +
        `Run \`keybroker init --migrate-keys\` to move them into the OS keychain.`,
    );
    masterKeyHex = masterKeyHex ?? raw.masterKeyHex ?? null;
    jwtSecret = jwtSecret ?? raw.jwtSecret ?? null;
  }

  if (!masterKeyHex || !jwtSecret) {
    throw new Error(
      `keybroker secrets missing from the OS keychain. ` +
        `Run \`keybroker init\` (or \`keybroker init --migrate-keys\` if upgrading from a pre-1.3 install).`,
    );
  }

  // Phase 4.0 c4: lazy-create the management secret on first load. New
  // installs (`init` after c4) generate it up front; old installs get a
  // freshly minted secret here without having to re-run init. The
  // secret never leaves the keychain unless an operator runs `token
  // mgmt --issue` to mint a JWT signed with it.
  if (!mgmtSecret) {
    mgmtSecret = generateJwtSecret();
    await kc.set(KC_MGMT_SECRET, mgmtSecret);
  }

  return {
    dataDir: dir,
    jsonStorePath: join(dir, "store.json"),
    sqliteStorePath: join(dir, "store.db"),
    logsPath: join(dir, "calls.log.jsonl"),
    configPath,
    policyPath: join(dir, "policy.json"),
    port: raw.port ?? Number(process.env.KEYBROKER_PORT ?? 7843),
    host: raw.host ?? process.env.KEYBROKER_HOST ?? "127.0.0.1",
    masterKeyHex,
    jwtSecret,
    mgmtSecret,
  };
}
