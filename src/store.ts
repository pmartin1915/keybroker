import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrokerConfig } from "./config.js";
import { JsonStore } from "./store-json.js";
import { SqliteStore } from "./store-sqlite.js";
import type { StoreLike } from "./store-types.js";

export type {
  StoreLike,
  SecretRecord,
  TokenRecord,
  ConsumeResult,
  RecentCallsOptions,
} from "./store-types.js";
export { JsonStore } from "./store-json.js";
export { SqliteStore } from "./store-sqlite.js";

export type StoreMode = "auto" | "sqlite" | "json";

export interface OpenStoreOptions {
  /** Storage backend. Default "auto" (sqlite, but errors if a non-migrated json store exists). */
  mode?: StoreMode;
  /** Mark the JSON store read-only (used after migrate). */
  readOnly?: boolean;
}

/**
 * Open the configured store. With mode="auto":
 * - if store.db exists → SQLite
 * - else if store.json exists (un-migrated) → throw with migration instructions
 * - else → SQLite (fresh install)
 */
export function openStore(
  config: BrokerConfig,
  opts: OpenStoreOptions = {},
): StoreLike {
  const mode = opts.mode ?? "auto";
  if (mode === "json") {
    return new JsonStore(config.jsonStorePath, config.logsPath, opts.readOnly);
  }
  if (mode === "sqlite") {
    return new SqliteStore(config.sqliteStorePath);
  }
  // auto
  if (existsSync(config.sqliteStorePath)) {
    return new SqliteStore(config.sqliteStorePath);
  }
  if (existsSync(config.jsonStorePath)) {
    throw new Error(
      `legacy JSON store found at ${config.jsonStorePath} but no SQLite store at ${config.sqliteStorePath}.\n` +
        `run \`keybroker migrate\` to convert, or pass --store=json to keep using JSON.`,
    );
  }
  return new SqliteStore(config.sqliteStorePath);
}

export function newTokenId(): string {
  return randomUUID();
}
