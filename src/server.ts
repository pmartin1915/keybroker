import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { request as undiciRequest } from "undici";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
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
import {
  estimateOutputCostUsd,
  actualCostUsd as actualCostUsdFor,
  parseUsageFromUpstream,
} from "./pricing.js";

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
          const extraction = provSpec.extractRequestMetadata(bodyBuf);
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
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            respBytes += chunk.byteLength;
            respTail.push(chunk);
            respTailBytes += chunk.byteLength;
            while (respTailBytes > RESP_TAIL_CAP && respTail.length > 1) {
              const dropped = respTail.shift();
              respTailBytes -= dropped?.byteLength ?? 0;
            }
            cb(null, chunk);
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
          // Try to reconcile actual cost from upstream usage. Only
          // priced models (i.e. those for which we already produced an
          // estimate, or any model the pricing table knows about) get an
          // actual; an unpriced model returning usage still can't be
          // converted to dollars. We re-check via actualCostUsdFor so we
          // catch the audit-only case where a non-capped token used a
          // priced model.
          if (requestedModelForCost !== undefined && respTail.length > 0) {
            try {
              const usage = parseUsageFromUpstream(Buffer.concat(respTail, respTailBytes));
              if (usage) {
                const actual = actualCostUsdFor({
                  model: requestedModelForCost,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                });
                if (actual !== undefined) entry.actualCostUsd = actual;
              }
            } catch {
              // Best-effort: a parse failure leaves actualCostUsd unset
              // and the cap accounting falls back to the pre-flight
              // estimate, which already counted toward the cap.
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
