/**
 * Per-request metadata extracted from the upstream request body.
 *
 * Phase 2.1 only consumes `model` (for the allow-list check). Phase 2.2
 * (dollar spend caps) will use `maxTokens` for the pre-flight cap estimate
 * and `stream` to dispatch the response-parsing path. Keeping all three on
 * the same digest avoids re-parsing the body in Phase 2.2 — one parse per
 * request, one place per provider.
 */
export interface RequestMetadata {
  model?: string;
  stream?: boolean;
  maxTokens?: number;
}

/**
 * Tagged result of body inspection. The kinds carry different security
 * meaning, so the server can take different actions per kind:
 *
 * - `ok`: body parsed, metadata extracted (model may still be undefined
 *   inside the meta — see `no-model` for the "no field at all" variant).
 * - `no-body`: GET/HEAD or otherwise empty. Cannot invoke a model.
 * - `unparseable`: body has bytes but JSON parse failed. Suspicious when
 *   the token is model-restricted — fail closed.
 * - `no-model`: parsed JSON, no `.model` field. For known LLM endpoints
 *   the upstream would reject anyway; we deny earlier so the broker's
 *   guard does not depend on upstream strictness.
 */
export type Extraction =
  | { kind: "ok"; meta: RequestMetadata }
  | { kind: "no-body" }
  | { kind: "unparseable" }
  | { kind: "no-model" };

/**
 * Inputs to a provider's request metadata extractor.
 *
 * Phase 3.2.5 widened this from a single `Buffer | undefined` to an object
 * because Gemini puts the requested model in the URL path (`/v1beta/models/
 * <model>:generateContent`), not the body. Providers that only care about
 * the body can ignore `path` and `method`; providers that care about both
 * (Gemini, and the Phase 3.6 scanner that wants to skip non-LLM paths) get
 * a single input shape.
 */
export interface ExtractorInput {
  body: Buffer | undefined;
  path: string;
  method: string;
}

export interface ProviderSpec {
  name: string;
  /** Upstream base URL — broker forwards `/${name}/<rest>` to `${baseUrl}/<rest>`. */
  baseUrl: string;
  /**
   * `bearer` sets `Authorization: Bearer <key>`. `header` sends the raw key
   * as the value of `authHeader` (defaults to `x-api-key` when unset). The
   * literal `"header"` replaced the older `"x-api-key"` literal in Phase
   * 3.2.5 once Gemini joined the lineup with `x-goog-api-key` — the auth
   * style is really just bearer-vs-named-header, and the header name is
   * configured separately.
   */
  authStyle: "bearer" | "header";
  /** Header name for `header` style. Ignored for bearer. Defaults to `x-api-key`. */
  authHeader?: string;
  /** Headers stripped from the request before forwarding (e.g. host headers). */
  stripHeaders: string[];
  /**
   * Inspect the upstream request and return a tagged Extraction.
   * Defining this field marks the provider as supporting per-token model
   * allow-lists (the `mdl` claim); providers without it cannot be issued
   * tokens with --model restrictions and will be rejected at `token issue`
   * time, AND the server will fail closed if such a token is somehow
   * presented.
   */
  extractRequestMetadata?: (req: ExtractorInput) => Extraction;
}

/**
 * OpenAI, Anthropic, and Mistral all put the requested model at top-level
 * `.model` in a JSON body, along with `stream` and `max_tokens`. Echo
 * follows the same shape so tests can exercise the allow-list path without
 * a real LLM provider.
 */
function jsonRequestMetadata(req: ExtractorInput): Extraction {
  const body = req.body;
  if (!body || body.byteLength === 0) return { kind: "no-body" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { kind: "no-model" };
  }
  const obj = parsed as Record<string, unknown>;
  const meta: RequestMetadata = {};
  if (typeof obj.model === "string" && obj.model.length > 0) {
    meta.model = obj.model;
  }
  if (typeof obj.stream === "boolean") {
    meta.stream = obj.stream;
  }
  // OpenAI: `max_tokens` (deprecated) or `max_completion_tokens`.
  // Anthropic / Mistral: `max_tokens`. Take the first numeric we find.
  const mt = obj.max_completion_tokens ?? obj.max_tokens;
  if (typeof mt === "number" && Number.isFinite(mt) && mt >= 0) {
    meta.maxTokens = mt;
  }
  if (meta.model === undefined) return { kind: "no-model" };
  return { kind: "ok", meta };
}

/**
 * Gemini's REST surface puts the model in the URL path:
 *   POST /v1beta/models/<model>:generateContent
 *   POST /v1beta/models/<model>:streamGenerateContent
 *
 * The action suffix after `:` also encodes stream-vs-not. The body carries
 * `generationConfig.maxOutputTokens` instead of OpenAI's `max_tokens`.
 *
 * Non-generation paths (e.g. `GET /v1beta/models`) are handled upstream of
 * this extractor — Fastify-level GET/HEAD bodies are stripped, so we land
 * in `no-body`. Paths that do carry a body but don't match the
 * `models/<model>:<action>` shape return `no-model` so the per-token mdl
 * gate fails closed.
 */
const GEMINI_GENERATE_PATH =
  /\/v1beta(?:\/[^/]+)*?\/models\/([^/:]+):([A-Za-z][A-Za-z0-9]*)/;

function geminiRequestMetadata(req: ExtractorInput): Extraction {
  if (!req.body || req.body.byteLength === 0) return { kind: "no-body" };

  const match = GEMINI_GENERATE_PATH.exec(req.path);
  const model = match?.[1];
  const action = match?.[2];

  // Body parse is best-effort — even when the model came from the path we
  // still want to surface `unparseable` so an mdl-restricted token can't
  // ride malformed JSON into upstream.
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = JSON.parse(req.body.toString("utf8")) as unknown;
    if (raw && typeof raw === "object") {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    return { kind: "unparseable" };
  }

  if (!model) return { kind: "no-model" };

  const meta: RequestMetadata = { model };
  if (action) {
    meta.stream = action.toLowerCase().startsWith("stream");
  }
  if (parsed) {
    const gc = parsed.generationConfig;
    if (gc && typeof gc === "object") {
      const mot = (gc as Record<string, unknown>).maxOutputTokens;
      if (typeof mot === "number" && Number.isFinite(mot) && mot >= 0) {
        meta.maxTokens = mot;
      }
    }
  }
  return { kind: "ok", meta };
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com",
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
    extractRequestMetadata: jsonRequestMetadata,
  },
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "header",
    authHeader: "x-api-key",
    stripHeaders: ["host", "content-length", "connection", "authorization"],
    extractRequestMetadata: jsonRequestMetadata,
  },
  gemini: {
    name: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    authStyle: "header",
    authHeader: "x-goog-api-key",
    stripHeaders: ["host", "content-length", "connection", "authorization"],
    extractRequestMetadata: geminiRequestMetadata,
  },
  mistral: {
    name: "mistral",
    baseUrl: "https://api.mistral.ai",
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
    extractRequestMetadata: jsonRequestMetadata,
  },
  // Built-in test provider. KEYBROKER_ECHO_BASE_URL may override the default,
  // but only if it points at a loopback address — otherwise the env var is
  // ignored. This keeps the echo provider from being turned into an SSRF
  // primitive on a shared host.
  echo: {
    name: "echo",
    baseUrl: resolveEchoBaseUrl(),
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
    extractRequestMetadata: jsonRequestMetadata,
  },
};

function resolveEchoBaseUrl(): string {
  const fallback = "http://127.0.0.1:9999";
  const override = process.env.KEYBROKER_ECHO_BASE_URL;
  if (!override) return fallback;
  try {
    const u = new URL(override);
    const host = u.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      return override;
    }
    console.warn(
      `keybroker: ignoring KEYBROKER_ECHO_BASE_URL=${override} (must be loopback)`,
    );
    return fallback;
  } catch {
    return fallback;
  }
}

export function getProvider(name: string): ProviderSpec | undefined {
  return PROVIDERS[name];
}
