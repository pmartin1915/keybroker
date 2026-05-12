import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicy,
  policyDeniesProvider,
  policyDeniesModel,
  policyDeniesTag,
  _resetPolicyCache,
  type Policy,
} from "../src/policy.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-policy-"));
  path = join(dir, "policy.json");
  _resetPolicyCache();
});

afterEach(() => {
  _resetPolicyCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadPolicy", () => {
  it("returns an empty policy when the file does not exist", () => {
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual([]);
    expect(p.allowedProviders).toEqual([]);
  });

  it("loads forbidden_models and allowed_providers", () => {
    writeFileSync(
      path,
      JSON.stringify({
        forbidden_models: ["gemini-3-pro-preview", "*-preview"],
        allowed_providers: ["openai", "anthropic"],
      }),
    );
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual(["gemini-3-pro-preview", "*-preview"]);
    expect(p.allowedProviders).toEqual(["openai", "anthropic"]);
  });

  it("ignores non-string entries in the lists", () => {
    writeFileSync(
      path,
      JSON.stringify({
        forbidden_models: ["good", 42, null, "", "also-good"],
        allowed_providers: [{}, "openai"],
      }),
    );
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual(["good", "also-good"]);
    expect(p.allowedProviders).toEqual(["openai"]);
  });

  it("treats unknown top-level fields as harmless", () => {
    writeFileSync(
      path,
      JSON.stringify({
        forbidden_models: ["x"],
        unknown_future_field: { whatever: true },
      }),
    );
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual(["x"]);
  });

  it("returns empty policy on parse error (fail open, intentionally)", () => {
    writeFileSync(path, "{not json");
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual([]);
    expect(p.allowedProviders).toEqual([]);
  });

  it("returns empty policy when the JSON root is not an object", () => {
    writeFileSync(path, '"a string"');
    const p = loadPolicy(path);
    expect(p.forbiddenModels).toEqual([]);
  });
});

describe("loadPolicy caching", () => {
  it("returns the cached value within the TTL even if the file changes", () => {
    writeFileSync(path, JSON.stringify({ forbidden_models: ["a"] }));
    const t0 = 1_000_000;
    const first = loadPolicy(path, { now: t0 });
    expect(first.forbiddenModels).toEqual(["a"]);

    writeFileSync(path, JSON.stringify({ forbidden_models: ["b"] }));
    // 500ms later, still inside the 1s TTL
    const second = loadPolicy(path, { now: t0 + 500 });
    expect(second.forbiddenModels).toEqual(["a"]);
  });

  it("re-reads after the TTL elapses", () => {
    writeFileSync(path, JSON.stringify({ forbidden_models: ["a"] }));
    const t0 = 2_000_000;
    loadPolicy(path, { now: t0 });

    writeFileSync(path, JSON.stringify({ forbidden_models: ["b"] }));
    // 1100ms later — past the 1s TTL
    const fresh = loadPolicy(path, { now: t0 + 1100 });
    expect(fresh.forbiddenModels).toEqual(["b"]);
  });

  it("treats deletion as 'now empty' once the TTL elapses", () => {
    writeFileSync(path, JSON.stringify({ forbidden_models: ["a"] }));
    const t0 = 3_000_000;
    loadPolicy(path, { now: t0 });

    unlinkSync(path);
    const fresh = loadPolicy(path, { now: t0 + 1100 });
    expect(fresh.forbiddenModels).toEqual([]);
  });
});

function emptyPolicy(over: Partial<Policy> = {}): Policy {
  return {
    forbiddenModels: [],
    allowedProviders: [],
    tagAllowlist: {},
    scanner: {
      enabled: true,
      verify: { enabled: true, on_failure: "block", detectors: ["github_pat", "stripe_live_key"] },
    },
    ...over,
  };
}

describe("policyDeniesProvider", () => {
  it("allows everything when allowed_providers is empty", () => {
    const p = emptyPolicy();
    expect(policyDeniesProvider(p, "openai")).toBe(false);
    expect(policyDeniesProvider(p, "anything-else")).toBe(false);
  });

  it("denies providers not in the allow-list", () => {
    const p = emptyPolicy({ allowedProviders: ["openai", "anthropic"] });
    expect(policyDeniesProvider(p, "openai")).toBe(false);
    expect(policyDeniesProvider(p, "anthropic")).toBe(false);
    expect(policyDeniesProvider(p, "gemini")).toBe(true);
  });
});

describe("policyDeniesModel", () => {
  it("returns false for any model when forbidden_models is empty", () => {
    const p = emptyPolicy();
    expect(policyDeniesModel(p, "anything")).toBe(false);
  });

  it("denies exact matches", () => {
    const p = emptyPolicy({ forbiddenModels: ["gemini-3-pro-preview"] });
    expect(policyDeniesModel(p, "gemini-3-pro-preview")).toBe(true);
    expect(policyDeniesModel(p, "gemini-3-pro")).toBe(false);
  });

  it("denies glob matches", () => {
    const p = emptyPolicy({ forbiddenModels: ["*-preview", "gpt-3.5-*"] });
    expect(policyDeniesModel(p, "gemini-3-pro-preview")).toBe(true);
    expect(policyDeniesModel(p, "o1-preview")).toBe(true);
    expect(policyDeniesModel(p, "gpt-3.5-turbo")).toBe(true);
    expect(policyDeniesModel(p, "gpt-4o-mini")).toBe(false);
  });
});

describe("loadPolicy: tag_allowlist (Phase 3.3)", () => {
  it("returns an empty allow-list when the field is absent", () => {
    writeFileSync(path, JSON.stringify({ forbidden_models: ["x"] }));
    const p = loadPolicy(path);
    expect(p.tagAllowlist).toEqual({});
  });

  it("loads per-tag allow-lists", () => {
    writeFileSync(
      path,
      JSON.stringify({
        tag_allowlist: {
          team: ["platform", "infra"],
          project: ["dispatcher", "broker"],
        },
      }),
    );
    const p = loadPolicy(path);
    expect(p.tagAllowlist.team).toEqual(["platform", "infra"]);
    expect(p.tagAllowlist.project).toEqual(["dispatcher", "broker"]);
    expect(p.tagAllowlist.env).toBeUndefined();
  });

  it("treats an explicit empty array as 'no restriction' (drops the key)", () => {
    // Rationale: editing a list down to [] to clear it should not flip
    // it to 'forbid everything'. Same convention as forbidden_models.
    writeFileSync(
      path,
      JSON.stringify({ tag_allowlist: { team: [], project: ["foo"] } }),
    );
    const p = loadPolicy(path);
    expect(p.tagAllowlist.team).toBeUndefined();
    expect(p.tagAllowlist.project).toEqual(["foo"]);
  });

  it("ignores non-string entries inside a list", () => {
    writeFileSync(
      path,
      JSON.stringify({
        tag_allowlist: { team: ["good", 42, null, "", "also"] },
      }),
    );
    const p = loadPolicy(path);
    expect(p.tagAllowlist.team).toEqual(["good", "also"]);
  });

  it("ignores tag_allowlist when it is not an object (array, number, string)", () => {
    writeFileSync(path, JSON.stringify({ tag_allowlist: ["team", "project"] }));
    const p = loadPolicy(path);
    expect(p.tagAllowlist).toEqual({});
  });

  it("ignores unknown tag keys (forward-compat with future tag types)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        tag_allowlist: {
          team: ["platform"],
          region: ["us-east"], // not a recognized tag key
        },
      }),
    );
    const p = loadPolicy(path);
    expect(p.tagAllowlist.team).toEqual(["platform"]);
    expect(Object.keys(p.tagAllowlist)).toEqual(["team"]);
  });
});

describe("policyDeniesTag", () => {
  it("returns false for every key when allow-list is empty", () => {
    const p = emptyPolicy();
    expect(policyDeniesTag(p, "team", "anything")).toBe(false);
    expect(policyDeniesTag(p, "project", "anything")).toBe(false);
    expect(policyDeniesTag(p, "env", "anything")).toBe(false);
  });

  it("returns false when the specific key has no allow-list", () => {
    const p = emptyPolicy({ tagAllowlist: { team: ["platform"] } });
    expect(policyDeniesTag(p, "project", "anything")).toBe(false);
    expect(policyDeniesTag(p, "env", "anything")).toBe(false);
  });

  it("denies values not in the per-key allow-list", () => {
    const p = emptyPolicy({
      tagAllowlist: { team: ["platform", "infra"], env: ["dev", "prod"] },
    });
    expect(policyDeniesTag(p, "team", "platform")).toBe(false);
    expect(policyDeniesTag(p, "team", "marketing")).toBe(true);
    expect(policyDeniesTag(p, "env", "dev")).toBe(false);
    expect(policyDeniesTag(p, "env", "qa")).toBe(true);
  });

  it("is case-sensitive (allow-list is the source of truth)", () => {
    const p = emptyPolicy({ tagAllowlist: { team: ["Platform"] } });
    expect(policyDeniesTag(p, "team", "platform")).toBe(true);
    expect(policyDeniesTag(p, "team", "Platform")).toBe(false);
  });
});
