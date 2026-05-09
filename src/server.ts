import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import { request as undiciRequest } from "undici";
import type { BrokerConfig } from "./config.js";
import { Store } from "./store.js";
import { scopeAllows, verifyToken } from "./tokens.js";
import { decrypt } from "./crypto.js";
import { getProvider } from "./providers/index.js";
import { appendCall, type CallLogEntry } from "./logging.js";

export async function buildServer(config: BrokerConfig) {
  const app = Fastify({ logger: { level: "info" } });
  const store = new Store(config.storePath);

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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
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
        }, config.logsPath);
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        const lk = k.toLowerCase();
        if (provSpec.stripHeaders.includes(lk)) continue;
        if (lk === "authorization") continue; // we set our own
        headers[k] = Array.isArray(v) ? v.join(",") : String(v);
      }
      if (provSpec.authStyle === "bearer") {
        headers["authorization"] = `Bearer ${upstreamKey}`;
      } else {
        headers[provSpec.authHeader ?? "x-api-key"] = upstreamKey;
      }

      const url = provSpec.baseUrl.replace(/\/$/, "") + upstreamPath +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");

      const body = req.method === "GET" || req.method === "HEAD"
        ? undefined
        : (req.body as unknown);
      const bodyBuf = body === undefined
        ? undefined
        : typeof body === "string"
          ? Buffer.from(body)
          : Buffer.from(JSON.stringify(body));

      try {
        const upstream = await undiciRequest(url, {
          method: req.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          headers,
          body: bodyBuf,
        });

        // Pass through status + headers (minus hop-by-hop).
        reply.status(upstream.statusCode);
        for (const [k, v] of Object.entries(upstream.headers)) {
          if (v === undefined) continue;
          const lk = k.toLowerCase();
          if (lk === "transfer-encoding" || lk === "connection") continue;
          reply.header(k, v as string | string[]);
        }
        const respBuf = Buffer.from(await upstream.body.arrayBuffer());
        const log: CallLogEntry = {
          ts: new Date().toISOString(),
          tokenId,
          label: claims.lbl,
          provider,
          method: req.method,
          path: upstreamPath,
          status: upstream.statusCode,
          durationMs: Date.now() - started,
          reqBytes: bodyBuf?.byteLength ?? 0,
          respBytes: respBuf.byteLength,
          outcome: "ok",
        };
        appendCall(config.logsPath, log);
        return reply.send(respBuf);
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
        appendCall(config.logsPath, log);
        return reply.status(502).send({ error: "upstream_error" });
      }
    },
  );

  return app;
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
  },
  logsPath: string,
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
  appendCall(logsPath, entry);
  return reply.status(status).send({ error: reason });
}
