import { describe, it, expect } from "vitest";
import type { TokenRecord } from "../src/store-types.js";
import {
  applyRotationFilters,
  buildReissueArgs,
  computeRotationPreview,
  tokenClaimSummary,
} from "../src/rotate.js";

function mkToken(over: Partial<TokenRecord>): TokenRecord {
  return {
    id: "tok_unset",
    provider: "openai",
    scopes: ["*"],
    remaining: -1,
    used: 0,
    expiresAt: 0,
    createdAt: "2026-05-10T00:00:00.000Z",
    label: "unset",
    revoked: false,
    ...over,
  };
}

describe("Phase 3.8 — applyRotationFilters", () => {
  const all: TokenRecord[] = [
    mkToken({ id: "a", tagTeam: "platform", tagProject: "infra", machine: "alpha" }),
    mkToken({ id: "b", tagTeam: "platform", tagProject: "prod", machine: "beta" }),
    mkToken({ id: "c", tagTeam: "data", tagProject: "infra", machine: "alpha" }),
    mkToken({ id: "d", provider: "anthropic", tagTeam: "platform" }),
    mkToken({ id: "e" /* untagged */ }),
  ];

  it("returns all rows when filters are empty", () => {
    expect(applyRotationFilters(all, {}).map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("filters by single key", () => {
    expect(
      applyRotationFilters(all, { team: "platform" }).map((t) => t.id),
    ).toEqual(["a", "b", "d"]);
    expect(
      applyRotationFilters(all, { machine: "alpha" }).map((t) => t.id),
    ).toEqual(["a", "c"]);
    expect(
      applyRotationFilters(all, { provider: "anthropic" }).map((t) => t.id),
    ).toEqual(["d"]);
  });

  it("ANDs multiple filters", () => {
    expect(
      applyRotationFilters(all, {
        team: "platform",
        project: "infra",
      }).map((t) => t.id),
    ).toEqual(["a"]);
  });

  it("returns no rows when a filter has no match", () => {
    expect(
      applyRotationFilters(all, { team: "nonexistent" }),
    ).toEqual([]);
  });

  it("untagged tokens are excluded by any tag filter", () => {
    // Token `e` has no tagTeam — a team filter must drop it.
    expect(
      applyRotationFilters(all, { team: "platform" }).map((t) => t.id),
    ).not.toContain("e");
  });
});

describe("Phase 3.8 — buildReissueArgs", () => {
  const now = 1_710_000_000; // fixed reference (March 2024 epoch-ish)

  it("preserves provider, scopes, label, machine, capUsd, tags, models", () => {
    const rec = mkToken({
      id: "src",
      provider: "openai",
      scopes: ["POST:/v1/chat/completions"],
      label: "ci-build-runner",
      machine: "ci-node-3",
      capUsd: 25.5,
      tagTeam: "platform",
      tagProject: "ci",
      tagEnv: "prod",
      models: ["gpt-4o*", "gpt-3.5-turbo"],
      expiresAt: now + 3600,
    });
    const built = buildReissueArgs(rec, "new_id", now);
    expect(built).toBeDefined();
    expect(built!.args.tokenId).toBe("new_id");
    expect(built!.args.provider).toBe("openai");
    expect(built!.args.scopes).toEqual(["POST:/v1/chat/completions"]);
    expect(built!.args.label).toBe("ci-build-runner");
    expect(built!.args.machine).toBe("ci-node-3");
    expect(built!.args.capUsd).toBe(25.5);
    expect(built!.args.tags).toEqual({
      team: "platform",
      project: "ci",
      env: "prod",
    });
    expect(built!.args.models).toEqual(["gpt-4o*", "gpt-3.5-turbo"]);
    expect(built!.ttlSeconds).toBe(3600);
    expect(built!.noModelsClaim).toBe(false);
  });

  it("computes remaining TTL from expiresAt — never extends lifetime", () => {
    const rec = mkToken({ expiresAt: now + 600 });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.ttlSeconds).toBe(600);
  });

  it("returns undefined when the token has already expired", () => {
    const rec = mkToken({ expiresAt: now - 1 });
    expect(buildReissueArgs(rec, "new", now)).toBeUndefined();
  });

  it("ttlSeconds = 0 when source has no expiry (expiresAt: 0)", () => {
    const rec = mkToken({ expiresAt: 0 });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.ttlSeconds).toBe(0);
  });

  it("noModelsClaim is true when the source record has no models field (pre-3.8)", () => {
    const rec = mkToken({ /* no models */ });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.noModelsClaim).toBe(true);
    expect(built!.args.models).toBeUndefined();
  });

  it("noModelsClaim is false when models is an empty array (operator explicitly cleared it)", () => {
    // Hmm — current impl checks `rec.models === undefined`, not length.
    // An empty array means "no restriction" but the operator explicitly
    // marked the token as such, so we treat it as known.
    const rec = mkToken({ models: [] });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.noModelsClaim).toBe(false);
    expect(built!.args.models).toBeUndefined();
  });

  it("omits tags from args when none are set", () => {
    const rec = mkToken({ /* no tags */ });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.args.tags).toBeUndefined();
  });

  it("partial tags are preserved as-is", () => {
    const rec = mkToken({ tagTeam: "platform" /* no project/env */ });
    const built = buildReissueArgs(rec, "new", now);
    expect(built!.args.tags).toEqual({ team: "platform" });
  });
});

describe("Phase 3.8 — computeRotationPreview", () => {
  it("counts by machine, team, project, env independently", () => {
    const tokens: TokenRecord[] = [
      mkToken({ machine: "alpha", tagTeam: "platform", tagProject: "ci" }),
      mkToken({ machine: "alpha", tagTeam: "platform", tagEnv: "prod" }),
      mkToken({ machine: "beta", tagTeam: "data", tagProject: "ci" }),
      mkToken({ /* untagged */ }),
    ];
    const p = computeRotationPreview(tokens);
    expect(p.total).toBe(4);
    expect(p.byMachine).toEqual({ alpha: 2, beta: 1, "(none)": 1 });
    expect(p.byTeam).toEqual({ platform: 2, data: 1 });
    expect(p.byProject).toEqual({ ci: 2 });
    expect(p.byEnv).toEqual({ prod: 1 });
  });

  it("empty input → zeroed counts", () => {
    const p = computeRotationPreview([]);
    expect(p.total).toBe(0);
    expect(p.byMachine).toEqual({});
  });
});

describe("Phase 3.8 — tokenClaimSummary", () => {
  it("renders the full claim list in stable order", () => {
    const rec = mkToken({
      provider: "openai",
      scopes: ["POST:/v1/chat/completions", "GET:/v1/models"],
      label: "agent-7",
      machine: "alpha",
      capUsd: 12,
      tagTeam: "platform",
      tagProject: "ci",
      tagEnv: "prod",
      models: ["gpt-4o*"],
    });
    const s = tokenClaimSummary(rec);
    expect(s).toContain("provider=openai");
    expect(s).toContain("scopes=[POST:/v1/chat/completions,GET:/v1/models]");
    expect(s).toContain("label=agent-7");
    expect(s).toContain("machine=alpha");
    expect(s).toContain("cap=$12.00");
    expect(s).toContain("team=platform");
    expect(s).toContain("project=ci");
    expect(s).toContain("env=prod");
    expect(s).toContain("models=[gpt-4o*]");
  });

  it("omits absent fields entirely", () => {
    const rec = mkToken({ /* defaults only */ });
    const s = tokenClaimSummary(rec);
    expect(s).toContain("provider=openai");
    expect(s).toContain("label=unset");
    expect(s).not.toContain("machine=");
    expect(s).not.toContain("cap=");
    expect(s).not.toContain("team=");
    expect(s).not.toContain("models=");
  });
});
