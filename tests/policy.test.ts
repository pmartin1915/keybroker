import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicy,
  policyDeniesProvider,
  policyDeniesModel,
  _resetPolicyCache,
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

describe("policyDeniesProvider", () => {
  it("allows everything when allowed_providers is empty", () => {
    const p = { forbiddenModels: [], allowedProviders: [] };
    expect(policyDeniesProvider(p, "openai")).toBe(false);
    expect(policyDeniesProvider(p, "anything-else")).toBe(false);
  });

  it("denies providers not in the allow-list", () => {
    const p = { forbiddenModels: [], allowedProviders: ["openai", "anthropic"] };
    expect(policyDeniesProvider(p, "openai")).toBe(false);
    expect(policyDeniesProvider(p, "anthropic")).toBe(false);
    expect(policyDeniesProvider(p, "gemini")).toBe(true);
  });
});

describe("policyDeniesModel", () => {
  it("returns false for any model when forbidden_models is empty", () => {
    const p = { forbiddenModels: [], allowedProviders: [] };
    expect(policyDeniesModel(p, "anything")).toBe(false);
  });

  it("denies exact matches", () => {
    const p = { forbiddenModels: ["gemini-3-pro-preview"], allowedProviders: [] };
    expect(policyDeniesModel(p, "gemini-3-pro-preview")).toBe(true);
    expect(policyDeniesModel(p, "gemini-3-pro")).toBe(false);
  });

  it("denies glob matches", () => {
    const p = { forbiddenModels: ["*-preview", "gpt-3.5-*"], allowedProviders: [] };
    expect(policyDeniesModel(p, "gemini-3-pro-preview")).toBe(true);
    expect(policyDeniesModel(p, "o1-preview")).toBe(true);
    expect(policyDeniesModel(p, "gpt-3.5-turbo")).toBe(true);
    expect(policyDeniesModel(p, "gpt-4o-mini")).toBe(false);
  });
});
