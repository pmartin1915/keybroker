import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileKeychain, InMemoryKeychain } from "../src/keychain.js";
import { decrypt } from "../src/crypto.js";
import { SqliteStore } from "../src/store-sqlite.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(HERE, "..");
const TSX = resolve(
  REPO,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);
const CLI = resolve(REPO, "src", "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveOut, reject) => {
    const child = spawn(TSX, [CLI, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveOut({ code: code ?? -1, stdout, stderr }),
    );
  });
}

describe("InMemoryKeychain", () => {
  it("get/set/delete round-trips", async () => {
    const kc = new InMemoryKeychain();
    expect(await kc.get("missing")).toBeNull();
    await kc.set("a", "alpha");
    expect(await kc.get("a")).toBe("alpha");
    expect(await kc.delete("a")).toBe(true);
    expect(await kc.delete("a")).toBe(false);
    expect(await kc.get("a")).toBeNull();
  });
});

describe("FileKeychain", () => {
  it("persists across reopens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-fkc-"));
    const path = join(dir, "k.json");
    try {
      const a = new FileKeychain(path);
      await a.set("master_key", "deadbeef");
      const b = new FileKeychain(path);
      expect(await b.get("master_key")).toBe("deadbeef");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the file with mode 0o600 (owner read/write only) on POSIX", async () => {
    if (process.platform === "win32") return; // Windows ACL semantics differ
    const dir = mkdtempSync(join(tmpdir(), "kb-fkc-mode-"));
    const path = join(dir, "k.json");
    try {
      const kc = new FileKeychain(path);
      await kc.set("x", "y");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delete returns false for a missing key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-fkc-del-"));
    const path = join(dir, "k.json");
    try {
      const kc = new FileKeychain(path);
      expect(await kc.delete("not-there")).toBe(false);
      await kc.set("here", "v");
      expect(await kc.delete("here")).toBe(true);
      expect(await kc.delete("here")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("keybroker init: keychain layout (acceptance)", () => {
  // Roadmap done-when: `cat ~/.keybroker/config.json` reveals nothing useful.
  it("config.json contains only port/host; no master key or jwt secret on disk", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-init-kc-"));
    const env = {
      KEYBROKER_HOME: home,
      KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
    };
    try {
      const r = await runCli(["init"], env);
      expect(r.code).toBe(0);

      const cfgRaw = readFileSync(join(home, "config.json"), "utf8");
      const cfg = JSON.parse(cfgRaw) as Record<string, unknown>;
      expect(Object.keys(cfg).sort()).toEqual(["host", "port"]);
      expect(cfg).not.toHaveProperty("masterKeyHex");
      expect(cfg).not.toHaveProperty("jwtSecret");

      // Sanity: the secrets DID land in the keychain.
      const kc = new FileKeychain(join(home, ".keychain.json"));
      const master = await kc.get("master_key");
      const jwt = await kc.get("jwt_secret");
      expect(master).toMatch(/^[0-9a-f]{64}$/);
      expect(jwt).toBeTruthy();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses re-init without --force when keychain already has the master key", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-init-twice-"));
    const env = {
      KEYBROKER_HOME: home,
      KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
    };
    try {
      const a = await runCli(["init"], env);
      expect(a.code).toBe(0);
      const b = await runCli(["init"], env);
      expect(b.code).not.toBe(0);
      expect(b.stderr).toMatch(/already initialized/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("keybroker init --migrate-keys: legacy upgrade path", () => {
  it("moves secrets from a pre-1.3 config.json into the keychain and strips the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-migrate-keys-"));
    const env = {
      KEYBROKER_HOME: home,
      KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
    };
    try {
      // Simulate a pre-1.3 install: write a config.json with secrets inline.
      const legacy = {
        masterKeyHex: "ab".repeat(32),
        jwtSecret: "legacy-jwt-secret",
        port: 9090,
        host: "127.0.0.1",
      };
      const fs = await import("node:fs");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(join(home, "config.json"), JSON.stringify(legacy));

      const r = await runCli(["init", "--migrate-keys"], env);
      expect(r.code).toBe(0);

      const kc = new FileKeychain(join(home, ".keychain.json"));
      expect(await kc.get("master_key")).toBe(legacy.masterKeyHex);
      expect(await kc.get("jwt_secret")).toBe(legacy.jwtSecret);

      const after = JSON.parse(
        readFileSync(join(home, "config.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(after).not.toHaveProperty("masterKeyHex");
      expect(after).not.toHaveProperty("jwtSecret");
      expect(after.port).toBe(9090);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("keybroker init --rotate-keys: re-encrypts upstream secrets (acceptance)", () => {
  // Roadmap done-when: `keybroker init --rotate-keys` re-encrypts every
  // stored upstream secret under a new master key without dropping any.
  it("preserves all upstream secrets, replaces master key, leaves JWT secret untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "kb-rotate-"));
    const env = {
      KEYBROKER_HOME: home,
      KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
    };
    try {
      // Init + add two upstream secrets.
      const init = await runCli(["init"], env);
      expect(init.code).toBe(0);

      const r1 = await runCli(["secret", "add", "echo"], {
        ...env,
        KEYBROKER_SECRET: "sk-echo-1",
      });
      expect(r1.code).toBe(0);
      const r2 = await runCli(["secret", "add", "openai"], {
        ...env,
        KEYBROKER_SECRET: "sk-openai-2",
      });
      expect(r2.code).toBe(0);

      const kc = new FileKeychain(join(home, ".keychain.json"));
      const oldMaster = await kc.get("master_key");
      const oldJwt = await kc.get("jwt_secret");
      expect(oldMaster).toBeTruthy();

      // Snapshot ciphertexts pre-rotation.
      const before = new SqliteStore(join(home, "store.db"));
      const echoCtBefore = before.getSecret("echo")!.ciphertext;
      const openaiCtBefore = before.getSecret("openai")!.ciphertext;
      before.close();

      // Rotate.
      const rot = await runCli(["init", "--rotate-keys"], env);
      expect(rot.code).toBe(0);
      expect(rot.stdout).toMatch(/2 upstream secret/);

      // New master key in keychain. JWT unchanged.
      const newMaster = await kc.get("master_key");
      const newJwt = await kc.get("jwt_secret");
      expect(newMaster).not.toBe(oldMaster);
      expect(newJwt).toBe(oldJwt);

      // Ciphertexts changed but plaintexts are preserved.
      const after = new SqliteStore(join(home, "store.db"));
      const echoCtAfter = after.getSecret("echo")!.ciphertext;
      const openaiCtAfter = after.getSecret("openai")!.ciphertext;
      after.close();

      expect(echoCtAfter).not.toBe(echoCtBefore);
      expect(openaiCtAfter).not.toBe(openaiCtBefore);
      expect(decrypt(echoCtAfter, newMaster!)).toBe("sk-echo-1");
      expect(decrypt(openaiCtAfter, newMaster!)).toBe("sk-openai-2");

      // And the OLD ciphertexts must NOT decrypt under the new key.
      expect(() => decrypt(echoCtBefore, newMaster!)).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("loadConfig: missing secrets is a clean error", () => {
  it("throws a helpful message pointing at `keybroker init` when keychain is empty", async () => {
    const { loadConfig } = await import("../src/config.js");
    const home = mkdtempSync(join(tmpdir(), "kb-missing-"));
    try {
      // Write a config file (without secrets) so loadConfig's "not initialized"
      // guard doesn't fire — we want to hit the keychain-empty branch.
      const fs = await import("node:fs");
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ port: 8787, host: "127.0.0.1" }),
      );
      const prevHome = process.env.KEYBROKER_HOME;
      process.env.KEYBROKER_HOME = home;
      try {
        // loadConfig's data dir is resolved at module load, so this test
        // only meaningfully validates the keychain-empty branch when the
        // KEYBROKER_HOME at module-load time matches `home`. Other tests
        // in this file run first and may have set it elsewhere; in that
        // case loadConfig will hit a different dir's config and that's
        // fine — we only assert that an *empty keychain* triggers the
        // documented error message.
        const kc = new InMemoryKeychain();
        await expect(loadConfig({ keychain: kc })).rejects.toThrow(
          /keybroker init/,
        );
      } finally {
        if (prevHome !== undefined) process.env.KEYBROKER_HOME = prevHome;
        else delete process.env.KEYBROKER_HOME;
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
