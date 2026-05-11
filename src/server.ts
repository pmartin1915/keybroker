import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { request as undiciRequest } from "undici";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { existsSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrokerConfig } from "./config.js";
import { openStore } from "./store.js";
import type { StoreLike, TagBucket } from "./store-types.js";
import { scopeAllows, verifyToken, type BrokerClaims } from "./tokens.js";
import { decrypt } from "./crypto.js";
import { getProvider } from "./providers/index.js";
import type { CallLogEntry } from "./logging.js";
import {
  loadPolicy,
  policyDeniesModel,
  policyDeniesProvider,
  type Policy,
} from "./policy.js";
import { matchesAny } from "./glob-match.js";
import { resolveDetectors, scanBytes } from "./scanner.js";
import {
  estimateOutputCostUsd,
  actualCostUsd as actualCostUsdFor,
  parseUsageFromUpstream,
} from "./pricing.js";
import {
  buildDenseCumulativeSeries,
  forecastBurn,
  utcDayOf,
  type BurnForecast,
} from "./forecast.js";

export interface BuildServerOptions {
  /** Pass `false` to silence fastify's logger (used in tests). */
  logger?: boolean | { level?: string };
  /** Inject a store. Defaults to `openStore(config)`. */
  store?: StoreLike;
}

export async function buildServer(
  config: BrokerConfig,
  opts: BuildServerOptions = {},
) {
  const app = Fastify({ logger: opts.logger ?? { level: "info" } });
  const store: StoreLike = opts.store ?? openStore(config);

  app.get("/health", async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const tokens = store.listTokens();
    const active = tokens.filter((t) => !t.revoked).length;
    return {
      // `keybroker_ok` is the field the dispatcher writes verbatim into
      // status/health-<machine>.json. Tautologically true if we responded
      // — the dispatcher's check is "did we get a response with this set?"
      // not the value itself.
      keybroker_ok: true,
      ok: true,
      version: "0.1.0",
      tokens: { active, revoked: tokens.length - active, total: tokens.length },
      calls: {
        last24h: store.countCallsSince(dayAgo),
        last24hSpendUsd: store.sumCostUsdSince(dayAgo),
        last24hSpendUsdByMachine: store.sumCostUsdByMachineSince(dayAgo),
      },
    };
  });

  // Phase 3.4: tag-bucketed spend dashboard endpoint. Same trust model as
  // /health — open on 127.0.0.1, intended for the operator's own
  // dashboard / CLI to curl. The store layer applies the
  // tagged-and-priced filter (untagged + denied excluded), so the route
  // is mostly query-string parsing + validation.
  app.get<{
    Querystring: { bucket?: string; since?: string; limit?: string };
  }>("/metrics/spend", async (req, reply) => {
    const bucket = req.query.bucket;
    if (bucket !== "team" && bucket !== "project" && bucket !== "env") {
      return reply.status(400).send({
        error: "invalid_bucket",
        hint: "bucket must be one of: team, project, env",
      });
    }
    const sinceRaw = req.query.since;
    if (!sinceRaw) {
      return reply.status(400).send({
        error: "missing_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=24h",
      });
    }
    const sinceTs = parseSinceShorthand(sinceRaw);
    if (sinceTs === undefined) {
      return reply.status(400).send({
        error: "invalid_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=24h or since=7d",
      });
    }
    const limitRaw = req.query.limit;
    let limit = 50;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1000) {
        return reply.status(400).send({
          error: "invalid_limit",
          hint: "limit must be an integer in 1..1000",
        });
      }
      limit = n;
    }
    return store.topTagsBySpend(bucket as TagBucket, sinceTs, limit);
  });

  // Phase 3.7: latency dashboard endpoint. Per-token p50/p95 of TTFT
  // and TPOT-mean over a `since` window. Same trust posture as the
  // other dashboard routes (open on 127.0.0.1; the operator's UI
  // curls it). Required params: `token` and `since`. `token` is
  // validated only for shape (`brk_…` or token-id form) so a typo'd
  // ID returns `sampleCount: 0` rather than a 4xx — the dashboard's
  // "no data" panel is the better UX than a route-level error.
  app.get<{
    Querystring: { token?: string; since?: string };
  }>("/metrics/latency", async (req, reply) => {
    const tokenId = req.query.token;
    if (!tokenId) {
      return reply.status(400).send({
        error: "missing_token",
        hint: "pass token=<id> (the jti of an issued token)",
      });
    }
    const sinceRaw = req.query.since;
    if (!sinceRaw) {
      return reply.status(400).send({
        error: "missing_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=24h",
      });
    }
    const sinceTs = parseSinceShorthand(sinceRaw);
    if (sinceTs === undefined) {
      return reply.status(400).send({
        error: "invalid_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=24h or since=7d",
      });
    }
    return store.latencyStatsByTokenSince(tokenId, sinceTs);
  });

  // Phase 4.0 c2: token list for the control plane. Same trust posture
  // as the /metrics/* routes (open on 127.0.0.1; intended for the
  // operator's own UI / curl). Each record is augmented with
  // `spendUsd` from `sumCostUsdByToken` so the dashboard can render a
  // cap-vs-spend bar without a second round trip. `?machine=` filters
  // server-side via the existing `listTokens` option; client-side
  // filtering by tag / provider is the caller's responsibility (the
  // expected fleet size is small enough that filtering in the
  // browser is fine).
  app.get<{
    Querystring: { machine?: string };
  }>("/tokens", async (req) => {
    const opts: { machine?: string } = {};
    if (req.query.machine !== undefined) opts.machine = req.query.machine;
    const tokens = store.listTokens(opts);
    return tokens.map((t) => ({ ...t, spendUsd: store.sumCostUsdByToken(t.id) }));
  });

  // Phase 4.0 c2: recent audit rows for the control plane. Mirrors the
  // CLI's `keybroker audit` command surface (limit + optional token /
  // machine filters). The store orders by recency descending; the
  // route caps `limit` at 1000 the same way `/metrics/spend` does
  // (the dashboard renders progressively; a misbehaving caller can't
  // exhaust the broker by passing `limit=1_000_000`).
  app.get<{
    Querystring: { limit?: string; token?: string; machine?: string };
  }>("/audit", async (req, reply) => {
    let limit = 100;
    const limitRaw = req.query.limit;
    if (limitRaw !== undefined) {
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1000) {
        return reply.status(400).send({
          error: "invalid_limit",
          hint: "limit must be an integer in 1..1000",
        });
      }
      limit = n;
    }
    const opts: { limit: number; tokenId?: string; machine?: string } = {
      limit,
    };
    if (req.query.token !== undefined) opts.tokenId = req.query.token;
    if (req.query.machine !== undefined) opts.machine = req.query.machine;
    return store.recentCalls(opts);
  });

  // Phase 4.0 c3: read-only policy view for the control plane. Returns
  // the same `Policy` shape `loadPolicy` resolves at request time, so
  // the UI surfaces exactly what the broker enforces. No edit
  // affordance here — write operations are deferred to Phase 4.0 c4
  // pending the management-auth decision.
  app.get("/policy", async () => {
    return loadPolicy(config.policyPath);
  });

  // Phase 3.5: linear-regression burn forecast. Two routes — per-token
  // (with cap projection) and per-tag (slope-only leaderboard). Same
  // trust posture as /health and /metrics/spend: open on 127.0.0.1.
  // The regression window is `since` (default 14d) and the response is
  // capped by `top` (default 10). Both clamp to sane bounds for the
  // same reason /metrics/spend does — `since` is parser-validated to
  // shorthand only, `top` is integer 1..1000.
  app.get<{
    Querystring: { since?: string; top?: string };
  }>("/forecast/tokens", async (req, reply) => {
    const since = parseForecastSince(req.query.since);
    if (since === undefined) {
      return reply.status(400).send({
        error: "invalid_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=14d (default)",
      });
    }
    const top = parseTopParam(req.query.top);
    if (top === undefined) {
      return reply
        .status(400)
        .send({ error: "invalid_top", hint: "top must be integer 1..1000" });
    }
    return forecastTokens(store, since, top);
  });

  app.get<{
    Querystring: { bucket?: string; since?: string; top?: string };
  }>("/forecast/tags", async (req, reply) => {
    const bucket = req.query.bucket;
    if (bucket !== "team" && bucket !== "project" && bucket !== "env") {
      return reply.status(400).send({
        error: "invalid_bucket",
        hint: "bucket must be one of: team, project, env",
      });
    }
    const since = parseForecastSince(req.query.since);
    if (since === undefined) {
      return reply.status(400).send({
        error: "invalid_since",
        hint: "pass since=<n>(s|m|h|d), e.g. since=14d (default)",
      });
    }
    const top = parseTopParam(req.query.top);
    if (top === undefined) {
      return reply
        .status(400)
        .send({ error: "invalid_top", hint: "top must be integer 1..1000" });
    }
    return forecastTags(store, bucket as TagBucket, since, top);
  });

  // Phase 4.0: serve the bundled React control plane at /ui. The web/
  // package builds into web/dist (gitignored). When dist exists we mount
  // @fastify/static rooted there; when it doesn't (fresh clone or skipped
  // build) we serve a single-page hint instead so /ui never 5xxs. The
  // route order matters: static must register before `/:provider/*`
  // because the catch-all would otherwise match /ui as `provider=ui`.
  const webDistDir = resolveWebDistDir();
  if (webDistDir) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/ui/",
      decorateReply: false,
    });
    // Fastify-static serves /ui/<asset>. Add an alias so a bare /ui
    // (no trailing slash) lands on the SPA entry point too.
    app.get("/ui", async (_req, reply) => reply.redirect("/ui/", 302));
  } else {
    app.get("/ui", async (_req, reply) => reply.redirect("/ui/", 302));
    app.get("/ui/*", async (_req, reply) => {
      reply.type("text/html; charset=utf-8");
      return UI_NOT_BUILT_HTML;
    });
  }

  app.all<{ Params: { provider: string; "*": string } }>(
    "/:provider/*",
    async (req, reply) => {
      const started = Date.now();
      const { provider } = req.params;
      const upstreamPath = "/" + (req.params["*"] ?? "");

      const provSpec = getProvider(provider);
      if (!provSpec) {
        return denied(reply, 404, "unknown_provider", {
          tokenId: "-",
          label: "-",
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
        }, store);
      }

      const presented = extractPresentedToken(req);
      if (!presented) {
        return denied(reply, 401, "no_token", {
          tokenId: "-",
          label: "-",
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
        }, store);
      }

      const verified = await verifyToken(config.jwtSecret, presented);
      if ("error" in verified) {
        return denied(reply, 401, `invalid_token:${verified.error}`, {
          tokenId: "-",
          label: "-",
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
        }, store);
      }
      const { tokenId, claims } = verified;

      // Capture attribution claims (machine + tags) once; threaded into
      // every audit entry for this request — success, denial, or error —
      // so the audit log unambiguously attributes the call. Pre-2.3
      // tokens have no `mch`; pre-3.3 tokens have no `tag`. The broker
      // never re-validates the tag claim against policy here; the CLI
      // is responsible for allow-list enforcement at issue time, and
      // anything signed is trusted to be the operator's intent.
      const machine = claims.mch;
      const auditAttribution: {
        machine?: string;
        claims?: BrokerClaims;
      } = { claims };
      if (machine !== undefined) auditAttribution.machine = machine;

      if (claims.prv !== provider) {
        return denied(reply, 403, "provider_mismatch", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      // Phase 2.4 fleet policy. Loaded fresh each request (cached 1s) so an
      // operator can edit policy.json and have changes take effect without
      // restarting the broker. Enforced AHEAD OF scope: even a "*"-scoped
      // token cannot reach a provider or model that policy disallows.
      const policy: Policy = loadPolicy(config.policyPath);
      if (policyDeniesProvider(policy, provider)) {
        return denied(reply, 403, "provider_forbidden", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      // Build the request body buffer up here so the model checks (policy
      // forbidden_models, per-token `mdl`) can inspect body.model before
      // we consume a quota slot. Fastify has already parsed the body per
      // its content-type by this point.
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (req.body as unknown);
      const bodyBuf = body === undefined
        ? undefined
        : typeof body === "string"
          ? Buffer.from(body)
          : Buffer.from(JSON.stringify(body));

      // Phase 3.6: inline secret scanner. Runs after provider deny
      // (provider_forbidden → no egress, so scanning would add noise)
      // and before the model gate (so a leaked secret blocks even when
      // the requested model is allowed). The bodyBuf we just built is
      // the same bytes that would be forwarded upstream — re-serialized
      // for object bodies, byte-identical for string bodies. Re-
      // serialization preserves the secret values themselves, which is
      // what the regexes target.
      //
      // SECURITY: `reason` carries the detector name only — NEVER the
      // matched substring. The matched bytes are the literal secret we
      // are blocking; logging them would defeat the scanner's purpose.
      const scannerDetectors = resolveDetectors(
        policy.scanner.enabled,
        policy.scanner.detectors,
      );
      const scanHit = scanBytes(bodyBuf, scannerDetectors);
      if (scanHit) {
        return blockedEgress(reply, scanHit.detector, {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: bodyBuf?.byteLength ?? 0,
          ...auditAttribution,
        }, store);
      }

      // Combined model gate:
      //   - Policy `forbidden_models` (Phase 2.4): system-wide deny-list,
      //     applied even when the token has no `mdl` claim. This is the
      //     literal Money Rule encoded as broker policy — the deny wins
      //     against any token, including wildcard scopes.
      //   - Per-token `mdl` allow-list (Phase 2.1): deny-by-default; when
      //     set we require an extractable model that matches.
      //
      // Deny-by-default for the per-token check means GET/HEAD (no body)
      // gets a free pass because no model can be invoked, but malformed
      // JSON or a missing `.model` is treated as suspicious — defending
      // the boundary at the broker rather than relying on upstream
      // strictness.
      //
      // SECURITY: the missing-extractor branch below is the actual
      // enforcement for `mdl`. The CLI mirror in `token issue` is a UX
      // guard — do not delete the runtime check on the assumption it is
      // redundant.
      const hasMdlClaim = !!(claims.mdl && claims.mdl.length > 0);
      const hasCapClaim = claims.cap !== undefined;
      const needsModelInspection =
        hasMdlClaim || policy.forbiddenModels.length > 0 || hasCapClaim;
      // Phase 2.2: pre-flight estimate captured here so the post-call
      // append-call writers (success / error / streaming-finished) can
      // record it on the audit entry. Stays undefined when there's no
      // cap to enforce or the model isn't priced.
      let estimatedCostUsd: number | undefined;
      // Phase 2.2: model captured at the same point so the post-call
      // usage parse can convert tokens → dollars without re-running the
      // body extractor. Stays undefined for non-LLM endpoints (e.g.
      // GET listings) or providers without extractRequestMetadata.
      let requestedModelForCost: string | undefined;
      if (needsModelInspection) {
        if (!provSpec.extractRequestMetadata) {
          if (hasMdlClaim) {
            // Token requires a model match but provider can't extract.
            return denied(reply, 403, "model_not_allowed", {
              tokenId,
              label: claims.lbl,
              provider,
              method: req.method,
              path: upstreamPath,
              started,
              reqBytes: bodyBuf?.byteLength ?? 0,
              ...auditAttribution,
            }, store);
          }
          if (hasCapClaim) {
            // A capped token on a provider whose body shape we can't read
            // means we can't estimate. Fail closed — same posture as
            // model_not_allowed for an mdl-restricted token.
            return denied(reply, 403, "cap_unpriced_model", {
              tokenId,
              label: claims.lbl,
              provider,
              method: req.method,
              path: upstreamPath,
              started,
              reqBytes: bodyBuf?.byteLength ?? 0,
              ...auditAttribution,
            }, store);
          }
          // Only policy is in play and the provider has no model surface
          // we can inspect. forbidden_models cannot apply here, so allow
          // through — the operator's deny-list is targeted at LLM
          // providers that DO expose a model field.
        } else {
          const extraction = provSpec.extractRequestMetadata({
            body: bodyBuf,
            path: upstreamPath,
            method: req.method,
          });
          switch (extraction.kind) {
            case "no-body":
              // GET/HEAD or empty body — no model invocable, allow through.
              break;
            case "unparseable":
            case "no-model":
              if (hasMdlClaim) {
                return denied(reply, 403, "model_not_allowed", {
                  tokenId,
                  label: claims.lbl,
                  provider,
                  method: req.method,
                  path: upstreamPath,
                  started,
                  reqBytes: bodyBuf?.byteLength ?? 0,
                  ...auditAttribution,
                }, store);
              }
              if (hasCapClaim) {
                // Same posture as the mdl deny: a capped token cannot
                // ride a body the broker can't price. Mirrors the
                // `model_not_allowed` semantics so a stolen capped token
                // can't bypass the cap by sending malformed JSON.
                return denied(reply, 403, "cap_unpriced_model", {
                  tokenId,
                  label: claims.lbl,
                  provider,
                  method: req.method,
                  path: upstreamPath,
                  started,
                  reqBytes: bodyBuf?.byteLength ?? 0,
                  ...auditAttribution,
                }, store);
              }
              // Policy alone with no extractable model — nothing to forbid.
              break;
            case "ok": {
              const requested = extraction.meta.model;
              if (requested !== undefined) {
                // Hoist into the outer scope so the post-call usage
                // reconciliation (below) can convert tokens → USD without
                // re-running the extractor on the same body.
                requestedModelForCost = requested;
              }
              // Policy `forbidden_models` first (system-wide guardrail).
              if (requested !== undefined && policyDeniesModel(policy, requested)) {
                return denied(reply, 403, "model_forbidden", {
                  tokenId,
                  label: claims.lbl,
                  provider,
                  method: req.method,
                  path: upstreamPath,
                  started,
                  reqBytes: bodyBuf?.byteLength ?? 0,
                  requestedModel: requested,
                  ...auditAttribution,
                }, store);
              }
              // Then per-token `mdl` (glob-matched as of Phase 2.4).
              if (hasMdlClaim) {
                if (requested === undefined || !matchesAny(requested, claims.mdl!)) {
                  return denied(reply, 403, "model_not_allowed", {
                    tokenId,
                    label: claims.lbl,
                    provider,
                    method: req.method,
                    path: upstreamPath,
                    started,
                    reqBytes: bodyBuf?.byteLength ?? 0,
                    requestedModel: requested,
                    ...auditAttribution,
                  }, store);
                }
              }
              // Phase 2.2: per-token cap pre-flight. Runs AFTER policy +
              // mdl checks so the deny reason is the most specific one
              // (a forbidden model gets `model_forbidden`, not
              // `cap_exceeded_estimate`). The estimate is conservative:
              // input tokens default to 0, so the bound is "if the model
              // emits its full max_tokens of output and zero input, this
              // is the cost". The cap should be set with that floor in
              // mind — see ROADMAP for the contract.
              if (hasCapClaim && requested !== undefined) {
                const est = estimateOutputCostUsd({
                  model: requested,
                  maxTokens: extraction.meta.maxTokens,
                });
                if (est === undefined) {
                  return denied(reply, 403, "cap_unpriced_model", {
                    tokenId,
                    label: claims.lbl,
                    provider,
                    method: req.method,
                    path: upstreamPath,
                    started,
                    reqBytes: bodyBuf?.byteLength ?? 0,
                    requestedModel: requested,
                    ...auditAttribution,
                  }, store);
                }
                const cumulative = store.sumCostUsdByToken(tokenId);
                // claims.cap is validated > 0 in verifyToken — no need to
                // re-guard here.
                if (cumulative + est > claims.cap!) {
                  return denied(reply, 403, "cap_exceeded_estimate", {
                    tokenId,
                    label: claims.lbl,
                    provider,
                    method: req.method,
                    path: upstreamPath,
                    started,
                    reqBytes: bodyBuf?.byteLength ?? 0,
                    requestedModel: requested,
                    ...auditAttribution,
                  }, store);
                }
                estimatedCostUsd = est;
              }
              break;
            }
            default: {
              // Fail-closed default: a future Extraction kind not handled
              // here must not silently bypass the model check. The
              // `_never` assignment is also a TypeScript exhaustiveness
              // check — adding a new kind without updating this switch
              // is a compile error.
              const _never: never = extraction;
              void _never;
              req.log.error(
                { unexpectedExtraction: extraction },
                "extractRequestMetadata returned an unhandled kind; failing closed",
              );
              return denied(reply, 403, "model_not_allowed", {
                tokenId,
                label: claims.lbl,
                provider,
                method: req.method,
                path: upstreamPath,
                started,
                reqBytes: bodyBuf?.byteLength ?? 0,
                ...auditAttribution,
              }, store);
            }
          }
        }
      }

      // Scope check runs AFTER policy + model checks — see roadmap 2.4:
      // "Policy is enforced *before* token scope" so that a system-wide
      // deny is reported as such rather than being masked by a narrower
      // scope deny.
      if (!scopeAllows(claims.scp, req.method, upstreamPath)) {
        return denied(reply, 403, "scope_denied", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: bodyBuf?.byteLength ?? 0,
          ...auditAttribution,
        }, store);
      }

      const consumed = store.consumeToken(tokenId);
      if (typeof consumed === "string") {
        const status =
          consumed === "exhausted" || consumed === "expired" ? 429 : 401;
        return denied(reply, status, consumed, {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      const secret = store.getSecret(provider);
      if (!secret) {
        return denied(reply, 500, "no_upstream_secret", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      let upstreamKey: string;
      try {
        upstreamKey = decrypt(secret.ciphertext, config.masterKeyHex);
      } catch (e) {
        req.log.error({ err: e }, "decrypt_failed");
        return denied(reply, 500, "decrypt_failed", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (provSpec.stripHeaders.includes(lk)) continue;
        if (lk === "authorization" || lk === "x-api-key") continue; // we set our own
        headers[k] = Array.isArray(v) ? v.join(",") : String(v);
      }
      if (provSpec.authStyle === "bearer") {
        headers["authorization"] = `Bearer ${upstreamKey}`;
      } else {
        headers[provSpec.authHeader ?? "x-api-key"] = upstreamKey;
      }

      // Build upstream URL via the URL constructor so the path and search are
      // each properly normalized — avoids any mismatch between the path the
      // scope check evaluated and what undici actually requests.
      let url: URL;
      try {
        url = new URL(provSpec.baseUrl);
        url.pathname = joinPaths(url.pathname, upstreamPath);
        const qIdx = req.url.indexOf("?");
        if (qIdx >= 0) {
          // Only the query — drop any fragment a client tried to smuggle in.
          const qs = req.url.slice(qIdx + 1).split("#")[0] ?? "";
          url.search = qs ? "?" + qs : "";
        }
      } catch {
        return denied(reply, 502, "bad_upstream_url", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
          ...auditAttribution,
        }, store);
      }

      try {
        const upstream = await undiciRequest(url.toString(), {
          method: req.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          headers,
          body: bodyBuf,
        });

        // Pass through status + headers (minus hop-by-hop).
        reply.status(upstream.statusCode);
        for (const [k, v] of Object.entries(upstream.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          reply.header(k, v as string | string[]);
        }

        // Stream the upstream body through a byte counter so SSE / streamed
        // completions arrive at the client incrementally. The audit log is
        // written from the `finished()` callback so respBytes reflects what
        // actually made it across — including aborted streams.
        //
        // Phase 2.2: also retain a tail buffer of the upstream body so we
        // can parse `usage` after the stream ends. We hold up to RESP_TAIL_CAP
        // bytes — enough for a buffered chat-completions JSON response,
        // and enough to capture the final SSE event(s) that carry usage
        // for streamed responses.
        //
        // PROVIDER CONTRACT (load-bearing): both OpenAI (with
        // stream_options.include_usage:true) and Anthropic place the
        // final usage event in the LAST few SSE messages of the stream.
        // If a future provider emits usage early then continues
        // streaming >256KB of content, the usage event would be evicted
        // before stream end. The system fails closed in that case:
        // `actualCostUsd` stays undefined and cap accounting falls back
        // to the (output-only) pre-flight estimate. Watch for this when
        // adding new providers; bump RESP_TAIL_CAP or change to a
        // dedicated usage scanner if needed.
        //
        // The cap is a memory ceiling; we never grow unbounded.
        let respBytes = 0;
        const RESP_TAIL_CAP = 256 * 1024;
        const respTail: Buffer[] = [];
        let respTailBytes = 0;
        // Phase 3.7: TTFT/TPOT capture. `firstByteAt` is the wall clock
        // at the first chunk emerging from the upstream body stream —
        // not the moment undici resolved the request promise. undici's
        // promise resolves once headers arrive, which for OpenAI/
        // Anthropic typically precedes the first body byte (prefill).
        // Measuring at the Transform sees the actual content latency
        // that the dispatcher / dashboard cares about. `finishedAt`
        // closes the stream; `tpot_ms_avg` falls out of the two plus
        // the upstream-reported `output_tokens`. Both stay undefined
        // when the stream emits zero chunks (no body — odd but
        // possible on HEAD or upstream errors); the audit row then
        // records `respBytes === 0` and no latency columns, matching
        // the IS NOT NULL filter on the stats query.
        let firstByteAt: number | undefined;
        let finishedAt: number | undefined;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            if (firstByteAt === undefined) firstByteAt = Date.now();
            respBytes += chunk.byteLength;
            respTail.push(chunk);
            respTailBytes += chunk.byteLength;
            while (respTailBytes > RESP_TAIL_CAP && respTail.length > 1) {
              const dropped = respTail.shift();
              respTailBytes -= dropped?.byteLength ?? 0;
            }
            cb(null, chunk);
          },
          flush(cb) {
            // `finished()` fires after this; capture the high-water
            // here to ensure tpot has both endpoints even if a stream-
            // error races the finalize promise.
            finishedAt = Date.now();
            cb();
          },
        });

        const reqBytes = bodyBuf?.byteLength ?? 0;
        const upstreamStatus = upstream.statusCode;
        const upstreamLabel = claims.lbl;
        const finalizeCallEntry = (outcome: "ok" | "error", reason?: string) => {
          const entry: CallLogEntry = {
            ts: new Date().toISOString(),
            tokenId,
            label: upstreamLabel,
            provider,
            method: req.method,
            path: upstreamPath,
            status: upstreamStatus,
            durationMs: Date.now() - started,
            reqBytes,
            respBytes,
            outcome,
          };
          if (reason !== undefined) entry.reason = reason;
          if (machine !== undefined) entry.machine = machine;
          applyTagAttribution(entry, claims);
          if (estimatedCostUsd !== undefined) entry.estimatedCostUsd = estimatedCostUsd;
          // Phase 3.7: latency split. TTFT is what we measured at the
          // Transform; TPOT-mean needs `output_tokens` from upstream
          // usage, so we attempt the parse here regardless of whether
          // `requestedModelForCost` is set (a non-LLM provider with no
          // model can still return usage; conversely a priced model
          // without usage produces no TPOT). The usage parse is best-
          // effort: a malformed tail leaves all three latency columns
          // intact except `tpotMsAvg`/`outputTokens`.
          let usage: { inputTokens: number; outputTokens: number } | undefined;
          if (respTail.length > 0) {
            try {
              usage = parseUsageFromUpstream(
                Buffer.concat(respTail, respTailBytes),
              );
            } catch {
              // Best-effort parse — leave usage undefined.
            }
          }
          if (usage) {
            if (usage.outputTokens > 0) entry.outputTokens = usage.outputTokens;
            if (requestedModelForCost !== undefined) {
              const actual = actualCostUsdFor({
                model: requestedModelForCost,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
              });
              if (actual !== undefined) entry.actualCostUsd = actual;
            }
          }
          if (firstByteAt !== undefined) {
            // TTFT can be 0 on extremely fast localhost upstreams; clamp
            // to >=0 to absorb any clock-step weirdness without
            // producing a negative audit column.
            entry.ttftMs = Math.max(0, firstByteAt - started);
            if (
              finishedAt !== undefined &&
              entry.outputTokens !== undefined &&
              entry.outputTokens > 0 &&
              finishedAt >= firstByteAt
            ) {
              entry.tpotMsAvg =
                (finishedAt - firstByteAt) / entry.outputTokens;
            }
          }
          store.appendCall(entry);
        };

        finished(counter).then(
          () => finalizeCallEntry("ok"),
          (err: unknown) => finalizeCallEntry("error", (err as Error).message),
        );

        upstream.body.pipe(counter);
        return reply.send(counter);
      } catch (e) {
        req.log.error({ err: e }, "upstream_error");
        const log: CallLogEntry = {
          ts: new Date().toISOString(),
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          status: 502,
          durationMs: Date.now() - started,
          reqBytes: bodyBuf?.byteLength ?? 0,
          respBytes: 0,
          outcome: "error",
          reason: (e as Error).message,
        };
        if (machine !== undefined) log.machine = machine;
        applyTagAttribution(log, claims);
        // Phase 2.2: an upstream connect/transport error never produced
        // usage. Record the estimate so the cap accounting still
        // counts this attempt — otherwise a stuck upstream + retries
        // could blow past the cap because each failed attempt looks
        // free.
        if (estimatedCostUsd !== undefined) log.estimatedCostUsd = estimatedCostUsd;
        store.appendCall(log);
        return reply.status(502).send({ error: "upstream_error" });
      }
    },
  );

  return app;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function joinPaths(a: string, b: string): string {
  const left = a.endsWith("/") ? a.slice(0, -1) : a;
  const right = b.startsWith("/") ? b : "/" + b;
  return left + right;
}

function extractPresentedToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
    if (auth.startsWith("brk_")) return auth.trim();
  }
  const xkey = req.headers["x-api-key"];
  if (typeof xkey === "string" && xkey.startsWith("brk_")) return xkey.trim();
  return undefined;
}

function denied(
  reply: FastifyReply,
  status: number,
  reason: string,
  ctx: {
    tokenId: string;
    label: string;
    provider: string;
    method: string;
    path: string;
    started: number;
    reqBytes: number;
    requestedModel?: string;
    machine?: string;
    /**
     * Phase 3.3: when present, tag attribution is pulled from the
     * signed `tag` claim onto the audit entry. Pre-3.3 tokens have
     * no `tag` claim, so the fields stay undefined. Early-pre-verify
     * call sites (unknown_provider, no_token, invalid_token) pass no
     * claims at all and write tagless audit rows — that's correct,
     * the request never authenticated.
     */
    claims?: BrokerClaims;
  },
  store: StoreLike,
) {
  const entry: CallLogEntry = {
    ts: new Date().toISOString(),
    tokenId: ctx.tokenId,
    label: ctx.label,
    provider: ctx.provider,
    method: ctx.method,
    path: ctx.path,
    status,
    durationMs: Date.now() - ctx.started,
    reqBytes: ctx.reqBytes,
    respBytes: 0,
    outcome: "denied",
    reason,
  };
  if (ctx.requestedModel !== undefined) entry.requestedModel = ctx.requestedModel;
  if (ctx.machine !== undefined) entry.machine = ctx.machine;
  applyTagAttribution(entry, ctx.claims);
  store.appendCall(entry);
  return reply.status(status).send({ error: reason });
}

/**
 * Phase 3.6: terminate the request because the inline scanner caught a
 * secret in the body. Distinct from `denied()` so the audit row's
 * `outcome` is `"egress_blocked"` (not `"denied"`), making FinOps and
 * SRE queries trivially partitionable: "show me the leaks the broker
 * caught this week" is `WHERE outcome = 'egress_blocked'`, regardless
 * of which detector fired.
 *
 * The response body shape (`{error, detector}`) is what the dispatcher
 * and dashboard surface to operators; the audit row's `reason` carries
 * the same detector name. **Neither path ever carries the matched
 * substring.**
 */
function blockedEgress(
  reply: FastifyReply,
  detector: string,
  ctx: {
    tokenId: string;
    label: string;
    provider: string;
    method: string;
    path: string;
    started: number;
    reqBytes: number;
    machine?: string;
    claims?: BrokerClaims;
  },
  store: StoreLike,
) {
  const entry: CallLogEntry = {
    ts: new Date().toISOString(),
    tokenId: ctx.tokenId,
    label: ctx.label,
    provider: ctx.provider,
    method: ctx.method,
    path: ctx.path,
    status: 403,
    durationMs: Date.now() - ctx.started,
    reqBytes: ctx.reqBytes,
    respBytes: 0,
    outcome: "egress_blocked",
    reason: detector,
  };
  if (ctx.machine !== undefined) entry.machine = ctx.machine;
  applyTagAttribution(entry, ctx.claims);
  store.appendCall(entry);
  return reply.status(403).send({ error: "egress_blocked", detector });
}

/**
 * Phase 3.4: parse the `since=` query parameter for /metrics/spend. We
 * accept a duration shorthand (`30s`, `10m`, `24h`, `7d`) only — no
 * raw ISO timestamps, since `Date.parse` is permissive enough that
 * an attacker-controlled string can produce surprising windows. The
 * shorthand is the operator-facing UX the dashboard cards and CLI both
 * use, and an ISO variant can be added later if a use case emerges.
 *
 * Returns the ISO timestamp at `now - duration`, or undefined for
 * unparseable input. The caller maps undefined to a 400 response.
 */
export function parseSinceShorthand(s: string): string | undefined {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = m[2]!;
  const msPerUnit: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  const ms = n * msPerUnit[unit]!;
  // Cap at ~10 years so a typo doesn't compute a nonsensical window
  // that pulls the entire calls table.
  if (ms > 10 * 365 * 86_400_000) return undefined;
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Phase 3.3: copy tag attribution from a verified JWT's `tag` claim onto
 * an audit entry. No-op when claims/tag is absent. Same posture as
 * machine: the broker doesn't re-validate against policy here — the
 * claim is trusted as signed.
 */
function applyTagAttribution(
  entry: CallLogEntry,
  claims: BrokerClaims | undefined,
): void {
  const tag = claims?.tag;
  if (!tag) return;
  if (tag.t !== undefined) entry.tagTeam = tag.t;
  if (tag.p !== undefined) entry.tagProject = tag.p;
  if (tag.e !== undefined) entry.tagEnv = tag.e;
}

/**
 * Phase 3.5: parse the `since=` query parameter for /forecast/*.
 * Defaults to 14d when absent — the standard FinOps regression window
 * (long enough to absorb day-of-week traffic patterns, short enough to
 * stay reactive to a runaway integration). Returns the ISO timestamp
 * at `now - duration`, or undefined on parse failure.
 */
function parseForecastSince(s: string | undefined): string | undefined {
  if (s === undefined) {
    return new Date(Date.now() - 14 * 86_400_000).toISOString();
  }
  return parseSinceShorthand(s);
}

/**
 * Phase 3.5: parse the `top=` query parameter for /forecast/*.
 * Defaults to 10. Same 1..1000 bounds as /metrics/spend's `limit`.
 * Returns undefined on invalid input so the caller can 400.
 */
function parseTopParam(s: string | undefined): number | undefined {
  if (s === undefined) return 10;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 1000) {
    return undefined;
  }
  return n;
}

/**
 * Phase 3.5: per-token forecast. One regression per non-revoked token
 * over the window starting at `sinceTs`. Tokens with no priced spend
 * get a flat 0-slope forecast (still useful as a "this token has been
 * idle" signal in the dashboard). Sort posture: tokens projected to
 * breach soonest come first; tokens with no projection (no cap, no
 * burn) are bucketed at the end in label-asc order so the UI is
 * stable.
 */
export interface TokenForecastRow extends BurnForecast {
  tokenId: string;
  label: string;
  provider: string;
  capUsd?: number;
  machine?: string;
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
}

export function forecastTokens(
  store: StoreLike,
  sinceTs: string,
  top: number,
): TokenForecastRow[] {
  const tokens = store.listTokens().filter((t) => !t.revoked);
  const startDay = sinceTs.slice(0, 10);
  const endDay = utcDayOf(new Date());
  const rows: TokenForecastRow[] = tokens.map((t) => {
    const sparse = store.dailySpendByTokenSince(t.id, sinceTs);
    const dense = buildDenseCumulativeSeries({ sparse, startDay, endDay });
    const f = forecastBurn({ series: dense, capUsd: t.capUsd });
    const row: TokenForecastRow = {
      tokenId: t.id,
      label: t.label,
      provider: t.provider,
      ...f,
    };
    if (t.capUsd !== undefined) row.capUsd = t.capUsd;
    if (t.machine !== undefined) row.machine = t.machine;
    if (t.tagTeam !== undefined) row.tagTeam = t.tagTeam;
    if (t.tagProject !== undefined) row.tagProject = t.tagProject;
    if (t.tagEnv !== undefined) row.tagEnv = t.tagEnv;
    return row;
  });
  rows.sort(compareForecastRows);
  return rows.slice(0, top);
}

/**
 * Stable sort: rows with a defined `daysUntilCap` come first in
 * ascending order (soonest breach wins). Rows without a projection
 * (no cap, or zero/negative slope) fall to the end and are
 * tiebroken by `label` so successive calls render identically.
 */
function compareForecastRows(
  a: TokenForecastRow,
  b: TokenForecastRow,
): number {
  const aHas = a.daysUntilCap !== undefined;
  const bHas = b.daysUntilCap !== undefined;
  if (aHas && bHas) {
    const diff = a.daysUntilCap! - b.daysUntilCap!;
    if (diff !== 0) return diff;
    return a.label.localeCompare(b.label);
  }
  if (aHas) return -1;
  if (bHas) return 1;
  return a.label.localeCompare(b.label);
}

/**
 * Phase 3.5: per-tag forecast. One regression per tag value (within
 * the chosen bucket). No cap → no `daysUntilCap`; the route exposes
 * the slope leaderboard, which the dashboard renders as "fastest-
 * burning teams/projects/envs". Sort by slope descending, ties by
 * key ascending — same alphabetic-tiebreak posture as /metrics/spend.
 */
export interface TagForecastRow extends BurnForecast {
  bucket: TagBucket;
  key: string;
}

export function forecastTags(
  store: StoreLike,
  bucket: TagBucket,
  sinceTs: string,
  top: number,
): TagForecastRow[] {
  const sparseAll = store.dailySpendByTagSince(bucket, sinceTs);
  // Group sparse rows by tag key. We don't know the full set of keys
  // ahead of time, so this map is the discovery step.
  const perKey = new Map<string, Array<{ day: string; usd: number }>>();
  for (const r of sparseAll) {
    let arr = perKey.get(r.key);
    if (!arr) {
      arr = [];
      perKey.set(r.key, arr);
    }
    arr.push({ day: r.day, usd: r.usd });
  }
  const startDay = sinceTs.slice(0, 10);
  const endDay = utcDayOf(new Date());
  const rows: TagForecastRow[] = [];
  for (const [key, sparse] of perKey.entries()) {
    const dense = buildDenseCumulativeSeries({ sparse, startDay, endDay });
    const f = forecastBurn({ series: dense });
    rows.push({ bucket, key, ...f });
  }
  rows.sort((a, b) => {
    const diff = b.slopeUsdPerDay - a.slopeUsdPerDay;
    if (diff !== 0) return diff;
    return a.key.localeCompare(b.key);
  });
  return rows.slice(0, top);
}

/**
 * Phase 4.0: locate `web/dist` relative to this source file's runtime
 * location. The project runs via tsx (no compile step), so __dirname-ish
 * lookup uses import.meta.url. Returns the absolute path if the bundle
 * has been built (index.html present), otherwise undefined — the server
 * then mounts a "not built" hint at /ui/*.
 */
function resolveWebDistDir(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = pathResolve(here, "..", "web", "dist");
    if (existsSync(pathResolve(candidate, "index.html"))) return candidate;
  } catch {
    // import.meta.url not file:// (rare) — fall through to undefined.
  }
  return undefined;
}

const UI_NOT_BUILT_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Keybroker — UI not built</title>
<style>
  body{margin:0;background:#0b0c0f;color:#e8e9ec;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  main{max-width:520px;background:#1a1d26;border:1px solid #2a2e3b;border-radius:10px;padding:28px 32px}
  h1{margin:0 0 12px;font-size:20px;letter-spacing:-0.02em}
  p{color:#9aa0b2;font-size:14px;line-height:1.5;margin:0 0 12px}
  code{background:#222635;border-radius:4px;padding:2px 6px;font-family:"SF Mono",Monaco,monospace;font-size:13px;color:#c8f560}
</style></head>
<body><main>
  <h1>Keybroker UI not built</h1>
  <p>The control-plane bundle is not present at <code>web/dist/</code>.</p>
  <p>From the repo root, run:</p>
  <p><code>cd web &amp;&amp; npm install &amp;&amp; npm run build</code></p>
  <p>Then refresh this page.</p>
</main></body></html>`;
