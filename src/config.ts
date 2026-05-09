import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";

export interface BrokerConfig {
  dataDir: string;
  storePath: string;
  logsPath: string;
  configPath: string;
  port: number;
  host: string;
  /** Hex-encoded 32-byte master key for AES-256-GCM at-rest encryption. */
  masterKeyHex: string;
  /** Symmetric secret used to sign/verify JWT tokens. */
  jwtSecret: string;
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

interface OnDiskConfig {
  masterKeyHex: string;
  jwtSecret: string;
  port?: number;
  host?: string;
}

export function loadConfig(): BrokerConfig {
  const dir = ensureDataDir();
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `keybroker not initialized. Run \`keybroker init\` first (looked in ${dir}).`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as OnDiskConfig;
  return {
    dataDir: dir,
    storePath: join(dir, "store.json"),
    logsPath: join(dir, "calls.log.jsonl"),
    configPath,
    port: raw.port ?? Number(process.env.KEYBROKER_PORT ?? 8787),
    host: raw.host ?? process.env.KEYBROKER_HOST ?? "127.0.0.1",
    masterKeyHex: raw.masterKeyHex,
    jwtSecret: raw.jwtSecret,
  };
}
