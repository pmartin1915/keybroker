#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir, loadConfig } from "./config.js";
import { generateJwtSecret, generateMasterKeyHex, encrypt } from "./crypto.js";
import {
  openStore,
  newTokenId,
  JsonStore,
  SqliteStore,
  type StoreMode,
  type TokenRecord,
} from "./store.js";
import { issueToken } from "./tokens.js";
import { PROVIDERS, getProvider } from "./providers/index.js";
import { buildServer } from "./server.js";

function parseStoreMode(s: string | undefined): StoreMode {
  if (!s) return "auto";
  if (s === "auto" || s === "sqlite" || s === "json") return s;
  throw new Error(`invalid --store value: ${s} (expected: auto|sqlite|json)`);
}

const program = new Command();
program
  .name("keybroker")
  .description(
    "Issue short-lived, scoped, attributable tokens that proxy to upstream API providers.",
  )
  .version("0.1.0")
  .option(
    "--store <mode>",
    "storage backend: auto (default) | sqlite | json",
    "auto",
  );

function storeMode(): StoreMode {
  return parseStoreMode(program.opts<{ store?: string }>().store);
}

program
  .command("init")
  .description("Initialize the broker (creates config, master key, jwt secret).")
  .option("--force", "overwrite existing config", false)
  .action((opts: { force?: boolean }) => {
    const dir = ensureDataDir();
    const configPath = join(dir, "config.json");
    if (existsSync(configPath) && !opts.force) {
      console.error(`already initialized at ${configPath} (use --force to overwrite)`);
      process.exitCode = 1;
      return;
    }
    const masterKeyHex = generateMasterKeyHex();
    const jwtSecret = generateJwtSecret();
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          masterKeyHex,
          jwtSecret,
          port: 8787,
          host: "127.0.0.1",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`initialized: ${configPath}`);
    console.log(`data dir:    ${dir}`);
    console.log(`port:        8787 (override with KEYBROKER_PORT)`);
    console.log(
      "\nsecurity note: the config file contains the master key and jwt secret in plaintext.",
    );
    console.log(
      "for production, store these in a real KMS or OS keychain — this prototype does not.",
    );
  });

const secret = program.command("secret").description("Manage upstream API keys.");

secret
  .command("add")
  .description("Add or replace the upstream API key for a provider.")
  .argument("<provider>", `provider name (one of: ${Object.keys(PROVIDERS).join(", ")})`)
  .option(
    "-v, --value <value>",
    "secret value (visible to `ps` — prefer KEYBROKER_SECRET env var instead)",
  )
  .action((provider: string, opts: { value?: string }) => {
    if (!getProvider(provider)) {
      console.error(`unknown provider: ${provider}`);
      console.error(`known: ${Object.keys(PROVIDERS).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const value = opts.value ?? process.env.KEYBROKER_SECRET;
    if (!value) {
      console.error(
        "no secret value provided. pass --value <secret> or set KEYBROKER_SECRET.",
      );
      process.exitCode = 1;
      return;
    }
    const cfg = loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    store.putSecret(provider, {
      provider,
      ciphertext: encrypt(value, cfg.masterKeyHex),
      createdAt: new Date().toISOString(),
    });
    console.log(`stored upstream secret for provider "${provider}".`);
  });

secret
  .command("list")
  .description("List providers with stored secrets.")
  .action(() => {
    const cfg = loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const rows = store.listSecrets();
    if (rows.length === 0) {
      console.log("(no secrets stored)");
      return;
    }
    for (const r of rows) {
      console.log(`${r.provider.padEnd(12)}  added ${r.createdAt}`);
    }
  });

const token = program.command("token").description("Manage broker tokens.");

token
  .command("issue")
  .description("Mint a new broker token.")
  .requiredOption("--provider <name>", "upstream provider (e.g. openai)")
  .option(
    "--scope <scope...>",
    'allowed scope, e.g. "POST:/v1/chat/completions". Repeat or pass "*" for unrestricted.',
    ["*"],
  )
  .option("--max-calls <n>", "maximum allowed calls (-1 = unlimited)", "-1")
  .option("--ttl <seconds>", "seconds until expiry (0 = no expiry)", "3600")
  .option("--label <label>", "free-form label for audit", "unlabeled")
  .action(
    async (opts: {
      provider: string;
      scope: string[];
      maxCalls: string;
      ttl: string;
      label: string;
    }) => {
      if (!getProvider(opts.provider)) {
        console.error(`unknown provider: ${opts.provider}`);
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      const store = openStore(cfg, { mode: storeMode() });
      const id = newTokenId();
      const ttl = Number(opts.ttl);
      const max = Number(opts.maxCalls);
      const rec: TokenRecord = {
        id,
        provider: opts.provider,
        scopes: opts.scope,
        remaining: max,
        used: 0,
        expiresAt: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0,
        createdAt: new Date().toISOString(),
        label: opts.label,
        revoked: false,
      };
      store.putToken(rec);
      const jwt = await issueToken(cfg.jwtSecret, {
        tokenId: id,
        provider: opts.provider,
        scopes: opts.scope,
        label: opts.label,
        ttlSeconds: ttl,
      });
      console.log(jwt);
      console.error(
        `\nissued token ${id} for ${opts.provider} (scope: ${opts.scope.join(", ")}, max-calls: ${max}, ttl: ${ttl}s)`,
      );
    },
  );

token
  .command("list")
  .description("List issued tokens.")
  .action(() => {
    const cfg = loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const rows = store.listTokens();
    if (rows.length === 0) {
      console.log("(no tokens)");
      return;
    }
    for (const t of rows) {
      const exp = t.expiresAt
        ? new Date(t.expiresAt * 1000).toISOString()
        : "never";
      const status = t.revoked
        ? "REVOKED"
        : t.expiresAt && Date.now() / 1000 > t.expiresAt
          ? "EXPIRED"
          : t.remaining === 0
            ? "EXHAUSTED"
            : "active";
      console.log(
        `${t.id}  ${t.provider.padEnd(10)}  ${status.padEnd(9)}  used=${t.used}  remaining=${t.remaining}  expires=${exp}  label=${t.label}`,
      );
    }
  });

token
  .command("revoke")
  .description("Revoke a token by id.")
  .argument("<id>")
  .action((id: string) => {
    const cfg = loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    if (store.revokeToken(id)) {
      console.log(`revoked ${id}`);
    } else {
      console.error(`no such token: ${id}`);
      process.exitCode = 1;
    }
  });

program
  .command("logs")
  .description("Tail recent call log entries.")
  .option("-n, --num <n>", "number of recent entries", "20")
  .option("--token <id>", "filter by token id")
  .action((opts: { num: string; token?: string }) => {
    const cfg = loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const limit = Number(opts.num);
    const entries = store.recentCalls(
      opts.token ? { limit, tokenId: opts.token } : { limit },
    );
    if (entries.length === 0) {
      console.log("(no logs yet)");
      return;
    }
    for (const e of entries) {
      const tag = e.outcome === "ok" ? "OK" : e.outcome.toUpperCase();
      console.log(
        `${e.ts}  ${tag.padEnd(7)}  ${String(e.status).padStart(3)}  ${e.method.padEnd(6)}  ${e.provider}${e.path}  ${e.durationMs}ms  token=${e.tokenId.slice(0, 8)}  ${e.reason ?? ""}`,
      );
    }
  });

program
  .command("migrate")
  .description(
    "One-shot migration of the legacy JSON store to SQLite. After this runs the JSON file is renamed to store.json.migrated.",
  )
  .option("--dry-run", "show what would be migrated, don't write", false)
  .action((opts: { dryRun?: boolean }) => {
    const cfg = loadConfig();
    if (existsSync(cfg.sqliteStorePath)) {
      console.error(
        `SQLite store already exists at ${cfg.sqliteStorePath}. ` +
          `Refusing to overwrite — delete it first if you really want to redo the migration.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!existsSync(cfg.jsonStorePath)) {
      console.error(`no JSON store at ${cfg.jsonStorePath} — nothing to migrate.`);
      process.exitCode = 1;
      return;
    }
    const json = new JsonStore(cfg.jsonStorePath, cfg.logsPath, true);
    const secrets = json.listSecrets();
    const tokens = json.listTokens();
    const calls = json.recentCalls({ limit: Number.MAX_SAFE_INTEGER });
    console.log(
      `migrating: ${secrets.length} secrets, ${tokens.length} tokens, ${calls.length} call log entries`,
    );
    if (opts.dryRun) {
      console.log("(dry-run — no changes written)");
      return;
    }
    const sqlite = new SqliteStore(cfg.sqliteStorePath);
    try {
      for (const { provider } of secrets) {
        const rec = json.getSecret(provider);
        if (rec) sqlite.putSecret(provider, rec);
      }
      for (const t of tokens) sqlite.putToken(t);
      for (const c of calls) sqlite.appendCall(c);
    } finally {
      sqlite.close?.();
    }
    const migratedMarker = `${cfg.jsonStorePath}.migrated`;
    renameSync(cfg.jsonStorePath, migratedMarker);
    console.log(`done. JSON store moved to ${migratedMarker}`);
    console.log("future calls will use the SQLite store at " + cfg.sqliteStorePath);
  });

program
  .command("serve")
  .description("Start the broker proxy server.")
  .option("-p, --port <port>", "override port")
  .option("-h, --host <host>", "override host")
  .action(async (opts: { port?: string; host?: string }) => {
    const cfg = loadConfig();
    const app = await buildServer(cfg);
    const port = opts.port ? Number(opts.port) : cfg.port;
    const host = opts.host ?? cfg.host;
    await app.listen({ port, host });
    console.log(`keybroker listening on http://${host}:${port}`);
    console.log(
      `point clients at http://${host}:${port}/<provider>/... and use a brk_ token as the bearer.`,
    );
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
