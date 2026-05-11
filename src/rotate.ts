import type { TokenRecord } from "./store-types.js";
import type { issueToken } from "./tokens.js";

/**
 * Phase 3.8: filter set for rotate-all / reissue-batch. AND across
 * keys — every passed filter must match. Tag matching is exact
 * (case-sensitive); machine is expected to be pre-normalized (the
 * CLI calls `normalizeMachine` before passing the filter in).
 */
export interface RotationFilters {
  team?: string;
  project?: string;
  env?: string;
  machine?: string;
  provider?: string;
}

/**
 * Phase 3.8: filter a token list by team/project/env/machine/provider
 * (AND across filters). Pure function so the CLI and tests share
 * exactly one filter definition.
 */
export function applyRotationFilters(
  tokens: TokenRecord[],
  filters: RotationFilters,
): TokenRecord[] {
  return tokens.filter((t) => {
    if (filters.team !== undefined && t.tagTeam !== filters.team) return false;
    if (filters.project !== undefined && t.tagProject !== filters.project)
      return false;
    if (filters.env !== undefined && t.tagEnv !== filters.env) return false;
    if (filters.machine !== undefined && t.machine !== filters.machine)
      return false;
    if (filters.provider !== undefined && t.provider !== filters.provider)
      return false;
    return true;
  });
}

export interface ReissuePlanItem {
  args: Parameters<typeof issueToken>[1];
  ttlSeconds: number;
  /**
   * True when the source record had no persisted `models` field (pre-
   * 3.8 record). The reissued token will be unrestricted on model
   * regardless of whether the source originally had a `--model`
   * restriction; the CLI prints a warning when this is set.
   */
  noModelsClaim: boolean;
}

/**
 * Phase 3.8: convert a TokenRecord into the issueToken args needed to
 * reissue it with identical claims. The remaining TTL is computed
 * from the old token's `expiresAt` — never extending lifetime. Returns
 * undefined when the old token has already expired (caller should skip
 * — no point reissuing a dead token).
 *
 * The new id is the caller's responsibility; this function does not
 * touch the random source so test code can pass a deterministic id.
 */
export function buildReissueArgs(
  rec: TokenRecord,
  newId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ReissuePlanItem | undefined {
  let ttlSeconds = 0;
  if (rec.expiresAt > 0) {
    const remaining = rec.expiresAt - nowSeconds;
    if (remaining <= 0) return undefined;
    ttlSeconds = remaining;
  }
  const tags: { team?: string; project?: string; env?: string } = {};
  if (rec.tagTeam !== undefined) tags.team = rec.tagTeam;
  if (rec.tagProject !== undefined) tags.project = rec.tagProject;
  if (rec.tagEnv !== undefined) tags.env = rec.tagEnv;
  const haveTag = Object.keys(tags).length > 0;
  const args: Parameters<typeof issueToken>[1] = {
    tokenId: newId,
    provider: rec.provider,
    scopes: rec.scopes,
    label: rec.label,
    ttlSeconds,
  };
  if (rec.models && rec.models.length > 0) args.models = rec.models;
  if (rec.machine !== undefined) args.machine = rec.machine;
  if (rec.capUsd !== undefined) args.capUsd = rec.capUsd;
  if (haveTag) args.tags = tags;
  return { args, ttlSeconds, noModelsClaim: rec.models === undefined };
}

/**
 * Phase 3.8: render a one-line claim summary for rotate-all output.
 * Mirrors `token list`'s row format so an operator can eyeball
 * "what's about to change". Label is the human-recognizable anchor;
 * id is opaque.
 */
export function tokenClaimSummary(rec: TokenRecord): string {
  const bits: string[] = [
    `provider=${rec.provider}`,
    `scopes=[${rec.scopes.join(",")}]`,
    `label=${rec.label}`,
  ];
  if (rec.machine) bits.push(`machine=${rec.machine}`);
  if (rec.capUsd !== undefined) bits.push(`cap=$${rec.capUsd.toFixed(2)}`);
  if (rec.tagTeam) bits.push(`team=${rec.tagTeam}`);
  if (rec.tagProject) bits.push(`project=${rec.tagProject}`);
  if (rec.tagEnv) bits.push(`env=${rec.tagEnv}`);
  if (rec.models && rec.models.length > 0)
    bits.push(`models=[${rec.models.join(",")}]`);
  return bits.join("  ");
}

/**
 * Phase 3.8: aggregate counts for `rotate-all --preview`. Pure shape
 * so the CLI can format it any way it wants (and tests can inspect
 * it without parsing stdout).
 */
export interface RotationPreview {
  total: number;
  byMachine: Record<string, number>;
  byTeam: Record<string, number>;
  byProject: Record<string, number>;
  byEnv: Record<string, number>;
}

export function computeRotationPreview(
  tokens: TokenRecord[],
): RotationPreview {
  const out: RotationPreview = {
    total: tokens.length,
    byMachine: {},
    byTeam: {},
    byProject: {},
    byEnv: {},
  };
  for (const t of tokens) {
    const m = t.machine ?? "(none)";
    out.byMachine[m] = (out.byMachine[m] ?? 0) + 1;
    if (t.tagTeam) out.byTeam[t.tagTeam] = (out.byTeam[t.tagTeam] ?? 0) + 1;
    if (t.tagProject)
      out.byProject[t.tagProject] = (out.byProject[t.tagProject] ?? 0) + 1;
    if (t.tagEnv) out.byEnv[t.tagEnv] = (out.byEnv[t.tagEnv] ?? 0) + 1;
  }
  return out;
}
