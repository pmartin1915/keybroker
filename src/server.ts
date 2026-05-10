import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { request as undiciRequest } from "undici";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";
import type { BrokerConfig } from "./config.js";
import { openStore } from "./store.js";
import type { StoreLike } from "./store-types.js";
import { scopeAllows, verifyToken } from "./tokens.js";
import { decrypt } from "./crypto.js";
import { getProvider } from "./providers/index.js";
import type { CallLogEntry } from "./logging.js";

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

  app.get("/health", async () => ({ ok: true }));

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

      if (claims.prv !== provider) {
        return denied(reply, 403, "provider_mismatch", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
        }, store);
      }

      if (!scopeAllows(claims.scp, req.method, upstreamPath)) {
        return denied(reply, 403, "scope_denied", {
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          started,
          reqBytes: 0,
        }, store);
      }

      // Build the request body buffer up here so the model-allow-list check
      // (which inspects body.model) can run before we consume a quota slot.
      // Fastify has already parsed the body per its content-type by this point.
      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (req.body as unknown);
      const bodyBuf = body === undefined
        ? undefined
        : typeof body === "string"
          ? Buffer.from(body)
          : Buffer.from(JSON.stringify(body));

      // Per-token model allow-list (Phase 2.1). Deny-by-default: when `mdl`
      // is set we require an extractable model that's in the allow-list.
      // Only `no-body` (GET/HEAD) gets a free pass — those requests cannot
      // invoke a model. Permissive-on-undefined would let an attacker with
      // a stolen token bypass the guard by sending malformed JSON, since
      // the broker's defense would then depend on upstream strictness
      // rather than being its own boundary.
      //
      // SECURITY: this missing-extractor branch is the actual enforcement.
      // The CLI mirror in `token issue` is a UX guard — do not delete the
      // runtime check on the assumption it is redundant.
      if (claims.mdl && claims.mdl.length > 0) {
        if (!provSpec.extractRequestMetadata) {
          return denied(reply, 403, "model_not_allowed", {
            tokenId,
            label: claims.lbl,
            provider,
            method: req.method,
            path: upstreamPath,
            started,
            reqBytes: bodyBuf?.byteLength ?? 0,
          }, store);
        }
        const extraction = provSpec.extractRequestMetadata(bodyBuf);
        switch (extraction.kind) {
          case "no-body":
            // GET/HEAD or empty body — no model invocable, allow through.
            break;
          case "unparseable":
          case "no-model":
            return denied(reply, 403, "model_not_allowed", {
              tokenId,
              label: claims.lbl,
              provider,
              method: req.method,
              path: upstreamPath,
              started,
              reqBytes: bodyBuf?.byteLength ?? 0,
            }, store);
          case "ok": {
            const requested = extraction.meta.model;
            if (requested === undefined || !claims.mdl.includes(requested)) {
              return denied(reply, 403, "model_not_allowed", {
                tokenId,
                label: claims.lbl,
                provider,
                method: req.method,
                path: upstreamPath,
                started,
                reqBytes: bodyBuf?.byteLength ?? 0,
                requestedModel: requested,
              }, store);
            }
            break;
          }
          default: {
            // Fail-closed default: a future Extraction kind not handled
            // here must not silently bypass the model check. The `_never`
            // assignment is also a TypeScript exhaustiveness check —
            // adding a new kind without updating this switch is a
            // compile error. The log line surfaces the unexpected value
            // for debugging if exhaustiveness was somehow bypassed.
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
            }, store);
          }
        }
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
        let respBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            respBytes += chunk.byteLength;
            cb(null, chunk);
          },
        });

        const reqBytes = bodyBuf?.byteLength ?? 0;
        const upstreamStatus = upstream.statusCode;
        const upstreamLabel = claims.lbl;

        finished(counter).then(
          () => {
            store.appendCall({
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
              outcome: "ok",
            });
          },
          (err: unknown) => {
            store.appendCall({
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
              outcome: "error",
              reason: (err as Error).message,
            });
          },
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
  store.appendCall(entry);
  return reply.status(status).send({ error: reason });
}
