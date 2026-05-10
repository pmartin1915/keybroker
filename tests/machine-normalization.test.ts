import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolveOut({ code: code ?? -1, stdout, stderr }),
    );
  });
}

/**
 * Phase 3.0 — `mch` claim is normalized at issue time (lowercase + trim) and
 * `--machine` filters apply the same normalization, so a token issued from
 * a Windows-cased hostname matches a lowercase filter on every fleet
 * member. End-to-end CLI test rather than a pure-function assert because
 * the normalization rule lives at the CLI boundary, not in `issueToken`.
 *
 * Bundled into a single it-block to keep the spawn count down — each
 * `tsx src/cli.ts` invocation costs ~1.5s on Windows CI.
 */
describe("CLI: --machine normalization (Phase 3.0)", () => {
  it(
    "issue→list→revoke-all all agree on the canonical (lowercase) form",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kb-mach-"));
      const env = {
        KEYBROKER_HOME: home,
        KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
      };
      try {
        const init = await runCli(["init"], env);
        expect(init.code, init.stderr).toBe(0);

        const issue = await runCli(
          ["token", "issue", "--provider", "echo", "--machine", "PERRY-PC"],
          env,
        );
        expect(issue.code, issue.stderr).toBe(0);
        // CLI confirms the canonical form on stderr ("machine: perry-pc"),
        // not the user-supplied PERRY-PC.
        expect(issue.stderr).toMatch(/machine: perry-pc/);
        expect(issue.stderr).not.toMatch(/machine: PERRY-PC/);

        // Filter with mixed-case input still matches (filter is normalized).
        const mixed = await runCli(
          ["token", "list", "--machine", "PERRY-PC"],
          env,
        );
        expect(mixed.code).toBe(0);
        expect(mixed.stdout).toMatch(/machine=perry-pc/);
        expect(mixed.stdout).not.toMatch(/no tokens/);

        // Bulk revoke with mixed-case still matches; --yes skips interactive
        // confirm so the test runs non-interactively.
        const revoke = await runCli(
          ["token", "revoke-all", "--machine", "PERRY-PC", "--yes"],
          env,
        );
        expect(revoke.code, revoke.stderr).toBe(0);
        expect(revoke.stdout).toMatch(/revoked /);

        // After revoke-all the token shows REVOKED under the lowercase filter.
        const after = await runCli(
          ["token", "list", "--machine", "perry-pc"],
          env,
        );
        expect(after.stdout).toMatch(/REVOKED/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
