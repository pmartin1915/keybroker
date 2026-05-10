#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { ensureDataDir, loadConfig } from "./config.js";
import {
  generateJwtSecret,
  generateMasterKeyHex,
  encrypt,
  decrypt,
} from "./crypto.js";
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
import { getKeychain, KC_JWT_SECRET, KC_MASTER_KEY } from "./keychain.js";

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
  .description(
    "Initialize the broker. Stores the master key and JWT secret in the OS keychain; writes only port/host to config.json.",
  )
  .option("--force", "overwrite existing config + keychain entries", false)
  .option(
    "--migrate-keys",
    "move secrets from a pre-1.3 config.json into the keychain (keeps the same key, no re-encryption)",
    false,
  )
  .option(
    "--rotate-keys",
    "generate a new master key and re-encrypt every stored upstream secret under it",
    false,
  )
  .action(
    async (opts: {
      force?: boolean;
      migrateKeys?: boolean;
      rotateKeys?: boolean;
    }) => {
      if (opts.migrateKeys) {
        await initMigrateKeys();
        return;
      }
      if (opts.rotateKeys) {
        await initRotateKeys();
        return;
      }
      const dir = ensureDataDir();
      const configPath = join(dir, "config.json");
      const kc = getKeychain();
      const existingMaster = await kc.get(KC_MASTER_KEY);
      if ((existsSync(configPath) || existingMaster) && !opts.force) {
        console.error(
          `already initialized (config at ${configPath}, keychain entry present). Use --force to overwrite.`,
        );
        process.exitCode = 1;
        return;
      }
      const masterKeyHex = generateMasterKeyHex();
      const jwtSecret = generateJwtSecret();
      await kc.set(KC_MASTER_KEY, masterKeyHex);
      await kc.set(KC_JWT_SECRET, jwtSecret);
      writeFileSync(
        configPath,
        JSON.stringify({ port: 8787, host: "127.0.0.1" }, null, 2),
        { mode: 0o600 },
      );
      console.log(`initialized: ${configPath}`);
      console.log(`data dir:    ${dir}`);
      console.log(`port:        8787 (override with KEYBROKER_PORT)`);
      console.log(
        `secrets:     stored in OS keychain under service "keybroker" (accounts: ${KC_MASTER_KEY}, ${KC_JWT_SECRET}).`,
      );
    },
  );

async function initMigrateKeys(): Promise<void> {
  const dir = ensureDataDir();
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    console.error(`no config at ${configPath} — nothing to migrate.`);
    process.exitCode = 1;
    return;
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    masterKeyHex?: string;
    jwtSecret?: string;
    port?: number;
    host?: string;
  };
  if (!raw.masterKeyHex || !raw.jwtSecret) {
    console.error(
      `config at ${configPath} has no plaintext secrets to migrate — already on the new layout.`,
    );
    process.exitCode = 1;
    return;
  }
  const kc = getKeychain();
  await kc.set(KC_MASTER_KEY, raw.masterKeyHex);
  await kc.set(KC_JWT_SECRET, raw.jwtSecret);
  // Strip the secrets from disk; preserve port/host.
  const stripped = JSON.stringify(
    { port: raw.port ?? 8787, host: raw.host ?? "127.0.0.1" },
    null,
    2,
  );
  writeFileSync(configPath, stripped, { mode: 0o600 });
  console.log(`secrets moved from ${configPath} into the OS keychain.`);
  console.log(`config.json now contains only port/host.`);
}

async function initRotateKeys(): Promise<void> {
  const cfg = await loadConfig();
  const store = openStore(cfg, { mode: storeMode() });
  const oldMasterKeyHex = cfg.masterKeyHex;
  const newMasterKeyHex = generateMasterKeyHex();

  // 1. Decrypt all upstream secrets with the old key, in memory.
  const secrets = store.listSecrets();
  const reEncrypted: Array<{ provider: string; ciphertext: string; createdAt: string }> = [];
  for (const { provider } of secrets) {
    const rec = store.getSecret(provider);
    if (!rec) continue;
    const plain = decrypt(rec.ciphertext, oldMasterKeyHex);
    reEncrypted.push({
      provider,
      ciphertext: encrypt(plain, newMasterKeyHex),
      createdAt: rec.createdAt,
    });
  }

  // 2. Write all re-encrypted secrets. The store is the source of truth for
  // ciphertext; if we crash between this and the keychain swap below, the
  // user can recover by re-running with the old keychain entry preserved
  // elsewhere — but this is a known sharp edge for the prototype.
  for (const r of reEncrypted) {
    store.putSecret(r.provider, r);
  }

  // 3. Atomically swap the master key in the keychain.
  const kc = getKeychain();
  await kc.set(KC_MASTER_KEY, newMasterKeyHex);

  store.close?.();
  console.log(
    `rotated master key. ${reEncrypted.length} upstream secret(s) re-encrypted.`,
  );
  console.log(
    `JWT secret unchanged — existing tokens still verify. Use --force on \`init\` to rotate the JWT secret separately (this invalidates all live tokens).`,
  );
}

const secret = program.command("secret").description("Manage upstream API keys.");

secret
  .command("add")
  .description("Add or replace the upstream API key for a provider.")
  .argument("<provider>", `provider name (one of: ${Object.keys(PROVIDERS).join(", ")})`)
  .option(
    "-v, --value <value>",
    "secret value (visible to `ps` — prefer KEYBROKER_SECRET env var instead)",
  )
  .action(async (provider: string, opts: { value?: string }) => {
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
    const cfg = await loadConfig();
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
  .action(async () => {
    const cfg = await loadConfig();
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
  .option(
    "--model <name...>",
    "restrict the token to one or more model names (glob: `*` is the only wildcard, " +
      "e.g. `gpt-4o-mini*`). Repeat or pass space-separated. Omit for no restriction. " +
      "Note: model-restricted tokens deny requests with non-JSON or model-less bodies " +
      "(the broker cannot verify the model otherwise). For non-LLM endpoints " +
      "(e.g. file uploads, audio transcriptions), issue a separate token without --model.",
  )
  .option(
    "--machine <name>",
    "machine to attribute the token to (defaults to os.hostname()). Pass --machine '' to omit the claim.",
  )
  .option(
    "--cap-usd <n>",
    "absolute USD spend cap for this token. The broker's pre-flight estimate is " +
      "OUTPUT-ONLY (model + max_tokens) — the broker has no tokenizer so input cost " +
      "is reconciled only post-call from upstream usage. Long-context or input-heavy " +
      "calls can exceed the cap before the broker notices; pad the cap accordingly. " +
      "Decimals allowed (e.g. 0.50). Omit / 0 = no cap.",
  )
  .action(
    async (opts: {
      provider: string;
      scope: string[];
      maxCalls: string;
      ttl: string;
      label: string;
      model?: string[];
      machine?: string;
      capUsd?: string;
    }) => {
      const provSpec = getProvider(opts.provider);
      if (!provSpec) {
        console.error(`unknown provider: ${opts.provider}`);
        process.exitCode = 1;
        return;
      }
      const models = opts.model && opts.model.length > 0 ? opts.model : undefined;
      if (models && !provSpec.extractRequestMetadata) {
        console.error(
          `provider "${opts.provider}" does not support per-token model restrictions ` +
            `(no request-body inspection registered). Issue without --model, or add an ` +
            `extractRequestMetadata implementation in src/providers/index.ts.`,
        );
        process.exitCode = 1;
        return;
      }
      const cfg = await loadConfig();
      const store = openStore(cfg, { mode: storeMode() });
      const id = newTokenId();
      const ttl = Number(opts.ttl);
      const max = Number(opts.maxCalls);
      // Default to os.hostname(); --machine "" explicitly opts out so an
      // operator who doesn't want machine attribution (e.g. for tokens
      // issued to a shared CI runner) can suppress it.
      const machine =
        opts.machine === undefined
          ? hostname()
          : opts.machine === ""
            ? undefined
            : opts.machine;
      // Phase 2.2: validate up front so a typo'd --cap-usd doesn't yield
      // a token with no cap silently. Empty / 0 / missing = no cap (the
      // broker treats `cap` as absent in all three cases).
      let capUsd: number | undefined;
      if (opts.capUsd !== undefined && opts.capUsd !== "") {
        const n = Number(opts.capUsd);
        if (!Number.isFinite(n) || n < 0) {
          console.error(
            `invalid --cap-usd value: ${opts.capUsd} (expected a non-negative finite number)`,
          );
          process.exitCode = 1;
          return;
        }
        if (n > 0) capUsd = n;
      }
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
      if (machine !== undefined) rec.machine = machine;
      if (capUsd !== undefined) rec.capUsd = capUsd;
      store.putToken(rec);
      const jwt = await issueToken(cfg.jwtSecret, {
        tokenId: id,
        provider: opts.provider,
        scopes: opts.scope,
        label: opts.label,
        ttlSeconds: ttl,
        models,
        machine,
        capUsd,
      });
      console.log(jwt);
      const modelSummary = models ? `, models: ${models.join(", ")}` : "";
      const machineSummary = machine ? `, machine: ${machine}` : "";
      const capSummary = capUsd !== undefined ? `, cap: $${capUsd.toFixed(2)}` : "";
      console.error(
        `\nissued token ${id} for ${opts.provider} (scope: ${opts.scope.join(", ")}, max-calls: ${max}, ttl: ${ttl}s${modelSummary}${machineSummary}${capSummary})`,
      );
    },
  );

token
  .command("list")
  .description("List issued tokens.")
  .option("--machine <name>", "filter by machine attribution")
  .action(async (opts: { machine?: string }) => {
    const cfg = await loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const rows = store.listTokens(
      opts.machine !== undefined ? { machine: opts.machine } : undefined,
    );
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
      const mach = t.machine ? `  machine=${t.machine}` : "";
      // Phase 2.2: when a cap is set, display "spent=$X / cap=$Y" so the
      // operator can eyeball remaining budget without hitting the audit
      // log. Spend is the same on-demand sum the cap check uses.
      const cap = t.capUsd !== undefined
        ? `  spent=$${store.sumCostUsdByToken(t.id).toFixed(4)}/cap=$${t.capUsd.toFixed(2)}`
        : "";
      console.log(
        `${t.id}  ${t.provider.padEnd(10)}  ${status.padEnd(9)}  used=${t.used}  remaining=${t.remaining}  expires=${exp}  label=${t.label}${mach}${cap}`,
      );
    }
  });

token
  .command("revoke")
  .description("Revoke a token by id.")
  .argument("<id>")
  .action(async (id: string) => {
    const cfg = await loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    if (store.revokeToken(id)) {
      console.log(`revoked ${id}`);
    } else {
      console.error(`no such token: ${id}`);
      process.exitCode = 1;
    }
  });

token
  .command("revoke-all")
  .description(
    "Bulk-revoke every active token attributed to a machine (laptop-was-stolen case).",
  )
  .requiredOption("--machine <name>", "machine to revoke all tokens for")
  .option(
    "--yes",
    "skip the interactive confirmation (required for non-interactive use)",
    false,
  )
  .action(async (opts: { machine: string; yes: boolean }) => {
    const cfg = await loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const candidates = store
      .listTokens({ machine: opts.machine })
      .filter((t) => !t.revoked);
    if (candidates.length === 0) {
      console.log(`(no active tokens for machine "${opts.machine}")`);
      return;
    }
    console.error(
      `about to revoke ${candidates.length} active token(s) for machine "${opts.machine}":`,
    );
    for (const t of candidates) {
      console.error(`  - ${t.id}  (label=${t.label})`);
    }
    if (!opts.yes) {
      // Bulk revoke is destructive and a typo'd --machine could nuke the
      // wrong fleet member. Require an explicit "yes" unless --yes was passed.
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const answer = await rl.question("type 'yes' to proceed: ");
        if (answer.trim() !== "yes") {
          console.error("aborted.");
          return;
        }
      } finally {
        rl.close();
      }
    }
    let revoked = 0;
    for (const t of candidates) {
      if (store.revokeToken(t.id)) {
        console.log(`revoked ${t.id}  (label=${t.label})`);
        revoked++;
      }
    }
    console.error(`done — ${revoked}/${candidates.length} revoked.`);
  });

program
  .command("logs")
  .description("Tail recent call log entries.")
  .option("-n, --num <n>", "number of recent entries", "20")
  .option("--token <id>", "filter by token id")
  .option("--machine <name>", "filter by machine attribution")
  .action(async (opts: { num: string; token?: string; machine?: string }) => {
    const cfg = await loadConfig();
    const store = openStore(cfg, { mode: storeMode() });
    const limit = Number(opts.num);
    const filter: { limit: number; tokenId?: string; machine?: string } = { limit };
    if (opts.token) filter.tokenId = opts.token;
    if (opts.machine !== undefined) filter.machine = opts.machine;
    const entries = store.recentCalls(filter);
    if (entries.length === 0) {
      console.log("(no logs yet)");
      return;
    }
    for (const e of entries) {
      const tag = e.outcome === "ok" ? "OK" : e.outcome.toUpperCase();
      const mach = e.machine ? `  machine=${e.machine}` : "";
      console.log(
        `${e.ts}  ${tag.padEnd(7)}  ${String(e.status).padStart(3)}  ${e.method.padEnd(6)}  ${e.provider}${e.path}  ${e.durationMs}ms  token=${e.tokenId.slice(0, 8)}${mach}  ${e.reason ?? ""}`,
      );
    }
  });

program
  .command("migrate")
  .description(
    "One-shot migration of the legacy JSON store to SQLite. After this runs the JSON file is renamed to store.json.migrated.",
  )
  .option("--dry-run", "show what would be migrated, don't write", false)
  .action(async (opts: { dryRun?: boolean }) => {
    const cfg = await loadConfig();
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
    const cfg = await loadConfig();
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
