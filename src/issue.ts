import type { BrokerConfig } from "./config.js";
import { getProvider } from "./providers/index.js";
import { normalizeMachine } from "./hostname.js";
import { policyDeniesTag, type Policy, type TagKey } from "./policy.js";
import { newTokenId } from "./store.js";
import type { StoreLike, TokenRecord } from "./store-types.js";
import { issueToken, MAX_TAG_VALUE_LEN } from "./tokens.js";

/**
 * Phase 4.0 c4: shared token-issue flow. Used by the CLI `token issue`
 * subcommand and by the `/admin/tokens` HTTP route, so validation and
 * record-shape stay in lockstep across both surfaces. The function is
 * the single source of truth for "what counts as a well-formed token
 * issuance request" — keep it that way.
 *
 * Returns either an `ok` success carrying the JWT + persisted record,
 * or a structured failure carrying an error code the caller can render
 * (CLI as stderr message; HTTP as a JSON body with a 400/403 status).
 */
export interface IssueTokenInput {
  provider: string;
  scopes?: string[];
  label?: string;
  /** Seconds until expiry. 0 = no expiry (CLI behavior); omitted = 3600s (1h). */
  ttlSeconds?: number;
  /** Max calls. -1 = unlimited (default). */
  maxCalls?: number;
  models?: string[];
  /**
   * Machine attribution. `undefined` = no claim (admin-route default —
   * the requesting machine is not necessarily the broker host). `""` =
   * explicit opt-out (same posture as the CLI's `--machine ''`). Any
   * other value is normalized (lowercase + trim) before being persisted.
   */
  machine?: string;
  capUsd?: number;
  tags?: { team?: string; project?: string; env?: string };
}

export type IssueTokenResult =
  | {
      ok: true;
      tokenId: string;
      jwt: string;
      record: TokenRecord;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
    };

export async function issueTokenFlow(
  cfg: BrokerConfig,
  store: StoreLike,
  policy: Policy,
  input: IssueTokenInput,
): Promise<IssueTokenResult> {
  // ── provider ────────────────────────────────────────────────────────
  if (typeof input.provider !== "string" || input.provider.length === 0) {
    return { ok: false, error: "missing_provider" };
  }
  const provSpec = getProvider(input.provider);
  if (!provSpec) {
    return {
      ok: false,
      error: "unknown_provider",
      hint: `provider "${input.provider}" is not registered`,
    };
  }

  // ── models ──────────────────────────────────────────────────────────
  const models =
    input.models && input.models.length > 0 ? input.models : undefined;
  if (models) {
    if (!models.every((m) => typeof m === "string" && m.length > 0)) {
      return { ok: false, error: "invalid_models" };
    }
    if (!provSpec.extractRequestMetadata) {
      return {
        ok: false,
        error: "model_restriction_unsupported",
        hint:
          `provider "${input.provider}" does not support per-token model restrictions ` +
          `(no extractRequestMetadata). Issue without --model.`,
      };
    }
  }

  // ── scopes / ttl / maxCalls ────────────────────────────────────────
  const scopes =
    input.scopes && input.scopes.length > 0 ? input.scopes : ["*"];
  if (!scopes.every((s) => typeof s === "string" && s.length > 0)) {
    return { ok: false, error: "invalid_scopes" };
  }
  const ttlSeconds =
    input.ttlSeconds === undefined ? 3600 : input.ttlSeconds;
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isFinite(ttlSeconds) ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 0
  ) {
    return { ok: false, error: "invalid_ttl" };
  }
  const maxCalls = input.maxCalls === undefined ? -1 : input.maxCalls;
  if (
    typeof maxCalls !== "number" ||
    !Number.isFinite(maxCalls) ||
    !Number.isInteger(maxCalls) ||
    maxCalls < -1
  ) {
    return { ok: false, error: "invalid_max_calls" };
  }
  const label =
    typeof input.label === "string" && input.label.length > 0
      ? input.label
      : "unlabeled";

  // ── machine ─────────────────────────────────────────────────────────
  // `undefined` skips normalization entirely (the admin route's
  // default — the calling machine isn't the broker host). The CLI
  // resolves hostname() before calling so we never auto-fill here.
  const machine =
    input.machine === undefined ? undefined : normalizeMachine(input.machine);

  // ── capUsd ──────────────────────────────────────────────────────────
  let capUsd: number | undefined;
  if (input.capUsd !== undefined && input.capUsd !== 0) {
    if (
      typeof input.capUsd !== "number" ||
      !Number.isFinite(input.capUsd) ||
      input.capUsd < 0
    ) {
      return {
        ok: false,
        error: "invalid_cap_usd",
        hint: "capUsd must be a non-negative finite number",
      };
    }
    if (input.capUsd > 0) capUsd = input.capUsd;
  }

  // ── tags ────────────────────────────────────────────────────────────
  const rawTags = input.tags ?? {};
  const tagInputs: Array<[TagKey, string | undefined]> = [
    ["team", rawTags.team],
    ["project", rawTags.project],
    ["env", rawTags.env],
  ];
  const tags: { team?: string; project?: string; env?: string } = {};
  for (const [key, raw] of tagInputs) {
    if (raw === undefined || raw === "") continue;
    if (typeof raw !== "string") {
      return { ok: false, error: "invalid_tag", hint: `tag.${key} must be a string` };
    }
    if (raw.length > MAX_TAG_VALUE_LEN) {
      return {
        ok: false,
        error: "tag_too_long",
        hint: `tag.${key} exceeds ${MAX_TAG_VALUE_LEN} chars`,
      };
    }
    if (policyDeniesTag(policy, key, raw)) {
      const list = policy.tagAllowlist[key];
      return {
        ok: false,
        error: "tag_not_in_allowlist",
        hint:
          `tag.${key} "${raw}" is not in the policy allow-list ` +
          `[${list?.join(", ") ?? ""}]`,
      };
    }
    tags[key] = raw;
  }
  const haveTag = !!(tags.team || tags.project || tags.env);

  // ── persist + sign ──────────────────────────────────────────────────
  const id = newTokenId();
  const rec: TokenRecord = {
    id,
    provider: input.provider,
    scopes,
    remaining: maxCalls,
    used: 0,
    expiresAt: ttlSeconds > 0 ? Math.floor(Date.now() / 1000) + ttlSeconds : 0,
    createdAt: new Date().toISOString(),
    label,
    revoked: false,
  };
  if (machine !== undefined) rec.machine = machine;
  if (capUsd !== undefined) rec.capUsd = capUsd;
  if (tags.team !== undefined) rec.tagTeam = tags.team;
  if (tags.project !== undefined) rec.tagProject = tags.project;
  if (tags.env !== undefined) rec.tagEnv = tags.env;
  if (models !== undefined) rec.models = models;
  store.putToken(rec);

  const issueArgs: Parameters<typeof issueToken>[1] = {
    tokenId: id,
    provider: input.provider,
    scopes,
    label,
    ttlSeconds,
  };
  if (models !== undefined) issueArgs.models = models;
  if (machine !== undefined) issueArgs.machine = machine;
  if (capUsd !== undefined) issueArgs.capUsd = capUsd;
  if (haveTag) issueArgs.tags = tags;
  const jwt = await issueToken(cfg.jwtSecret, issueArgs);

  return { ok: true, tokenId: id, jwt, record: rec };
}
