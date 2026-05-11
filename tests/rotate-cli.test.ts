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
 * Phase 3.8 — `rotate-all` and `reissue-batch` end-to-end through the
 * CLI. Bundled into one big it-block per scenario to keep spawn count
 * down (each tsx invocation costs ~1.5s on Windows CI).
 *
 * Scope check:
 *   - rotate-all --preview prints counts only, no revoke, no reissue.
 *   - rotate-all --dry-run prints the plan, no writes.
 *   - rotate-all (real) revokes the matched set + reissues with
 *     identical claims (provider, scopes, label, machine, cap, tags).
 *   - rotate-all requires at least one filter (full-fleet guardrail).
 *   - reissue-batch picks up the just-revoked tokens via --since and
 *     reissues them.
 */
describe("CLI: rotate-all + reissue-batch (Phase 3.8)", () => {
  it(
    "preview / dry-run / real run agree on the affected count and parity",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kb-rot-"));
      const env = {
        KEYBROKER_HOME: home,
        KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
      };
      try {
        const init = await runCli(["init"], env);
        expect(init.code, init.stderr).toBe(0);

        // Issue 3 tokens with various tag combinations.
        // a + b match `--team platform`; c does not.
        const a = await runCli(
          [
            "token",
            "issue",
            "--provider",
            "echo",
            "--team",
            "platform",
            "--project",
            "ci",
            "--label",
            "tok-a",
          ],
          env,
        );
        expect(a.code, a.stderr).toBe(0);
        const b = await runCli(
          [
            "token",
            "issue",
            "--provider",
            "echo",
            "--team",
            "platform",
            "--label",
            "tok-b",
          ],
          env,
        );
        expect(b.code, b.stderr).toBe(0);
        const c = await runCli(
          [
            "token",
            "issue",
            "--provider",
            "echo",
            "--team",
            "data",
            "--label",
            "tok-c",
          ],
          env,
        );
        expect(c.code, c.stderr).toBe(0);

        // --preview: should report 2 matched for --team platform.
        const preview = await runCli(
          ["token", "rotate-all", "--team", "platform", "--preview"],
          env,
        );
        expect(preview.code, preview.stderr).toBe(0);
        expect(preview.stdout).toMatch(/active matched: 2/);
        expect(preview.stdout).toMatch(/platform: 2/);
        // No "revoke" output in preview.
        expect(preview.stdout).not.toMatch(/revoked /);

        // --dry-run: should list the plan but not change state.
        const dryRun = await runCli(
          ["token", "rotate-all", "--team", "platform", "--dry-run", "--yes"],
          env,
        );
        expect(dryRun.code, dryRun.stderr).toBe(0);
        expect(dryRun.stderr).toMatch(/rotate plan: 2 reissue/);
        expect(dryRun.stdout).toMatch(/dry-run/);
        // Sanity: original tokens still active after dry-run.
        const listAfterDry = await runCli(["token", "list"], env);
        expect(listAfterDry.stdout).toMatch(/tok-a/);
        expect(listAfterDry.stdout).toMatch(/tok-b/);
        expect(listAfterDry.stdout).not.toMatch(/REVOKED/);

        // No-filter rejection.
        const noFilter = await runCli(
          ["token", "rotate-all", "--yes"],
          env,
        );
        expect(noFilter.code).not.toBe(0);
        expect(noFilter.stderr).toMatch(/at least one filter/);

        // Real run.
        const real = await runCli(
          ["token", "rotate-all", "--team", "platform", "--yes"],
          env,
        );
        expect(real.code, real.stderr).toBe(0);
        expect(real.stderr).toMatch(/done — 2\/2 revoked, 2\/2 reissued/);
        // The two new JWTs land on stdout, one per reissue block.
        const jwtLines = real.stdout.split("\n").filter((l) =>
          l.startsWith("brk_"),
        );
        expect(jwtLines).toHaveLength(2);

        // Verify state: old `tok-a` / `tok-b` records are revoked, two
        // new active records exist with the same labels and tags.
        const listAfter = await runCli(["token", "list"], env);
        expect(listAfter.code, listAfter.stderr).toBe(0);
        // The labels carry across — old (REVOKED) and new (active)
        // both show tok-a / tok-b.
        const tokALines = listAfter.stdout
          .split("\n")
          .filter((l) => l.includes("label=tok-a"));
        expect(tokALines.length).toBe(2);
        expect(tokALines.some((l) => l.includes("REVOKED"))).toBe(true);
        expect(tokALines.some((l) => l.includes("active"))).toBe(true);
        // tok-c untouched.
        const tokCLines = listAfter.stdout
          .split("\n")
          .filter((l) => l.includes("label=tok-c"));
        expect(tokCLines.length).toBe(1);
        expect(tokCLines[0]).toMatch(/active/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "reissue-batch picks up revoked tokens within --since and reissues with parity",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kb-reis-"));
      const env = {
        KEYBROKER_HOME: home,
        KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
      };
      try {
        const init = await runCli(["init"], env);
        expect(init.code, init.stderr).toBe(0);

        // Issue, then revoke (via revoke-all --machine), then
        // reissue-batch picks it up.
        const issue = await runCli(
          [
            "token",
            "issue",
            "--provider",
            "echo",
            "--machine",
            "alpha",
            "--label",
            "tok-x",
            "--cap-usd",
            "10",
          ],
          env,
        );
        expect(issue.code, issue.stderr).toBe(0);

        const revoke = await runCli(
          ["token", "revoke-all", "--machine", "alpha", "--yes"],
          env,
        );
        expect(revoke.code, revoke.stderr).toBe(0);
        expect(revoke.stderr).toMatch(/1\/1 revoked/);

        // Now reissue-batch should match the just-revoked one.
        const reissue = await runCli(
          [
            "token",
            "reissue-batch",
            "--since",
            "1h",
            "--from-revoked",
            "--machine",
            "alpha",
            "--yes",
          ],
          env,
        );
        expect(reissue.code, reissue.stderr).toBe(0);
        expect(reissue.stderr).toMatch(/reissue plan: 1 reissue/);
        expect(reissue.stderr).toMatch(/done — 1\/1 reissued/);
        const jwtLines = reissue.stdout
          .split("\n")
          .filter((l) => l.startsWith("brk_"));
        expect(jwtLines).toHaveLength(1);

        // List should now have 2 records: the revoked source and a
        // new active one, both labeled tok-x with cap=$10.
        const list = await runCli(["token", "list"], env);
        const xLines = list.stdout
          .split("\n")
          .filter((l) => l.includes("label=tok-x"));
        expect(xLines.length).toBe(2);
        // Both should carry the cap and the machine.
        for (const l of xLines) {
          expect(l).toMatch(/machine=alpha/);
          expect(l).toMatch(/cap=\$10\.00/);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "preserves --model on a token issued post-3.8 (no lossy warning, mdl claim survives rotation)",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "kb-model-"));
      const env = {
        KEYBROKER_HOME: home,
        KEYBROKER_KEYCHAIN_PATH: join(home, ".keychain.json"),
      };
      try {
        await runCli(["init"], env);
        const issue = await runCli(
          [
            "token",
            "issue",
            "--provider",
            "echo",
            "--team",
            "platform",
            "--model",
            "gpt-4o*",
            "--label",
            "model-tok",
          ],
          env,
        );
        expect(issue.code, issue.stderr).toBe(0);

        const rotate = await runCli(
          ["token", "rotate-all", "--team", "platform", "--yes"],
          env,
        );
        expect(rotate.code, rotate.stderr).toBe(0);
        // No lossy warning — the source record had `models` persisted.
        expect(rotate.stderr).not.toMatch(/no persisted model restriction/);
        // The summary line should still mention the model.
        expect(rotate.stderr).toMatch(/models=\[gpt-4o\*\]/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
