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

export interface ProviderSpec {
  name: string;
  /** Upstream base URL — broker forwards `/${name}/<rest>` to `${baseUrl}/<rest>`. */
  baseUrl: string;
  /** How the upstream wants the API key. */
  authStyle: "bearer" | "x-api-key";
  /** Header name for x-api-key style. Ignored for bearer. */
  authHeader?: string;
  /** Headers stripped from the request before forwarding (e.g. host headers). */
  stripHeaders: string[];
  /**
   * Inspect the upstream request body and return a tagged Extraction.
   * Defining this field marks the provider as supporting per-token model
   * allow-lists (the `mdl` claim); providers without it cannot be issued
   * tokens with --model restrictions and will be rejected at `token issue`
   * time, AND the server will fail closed if such a token is somehow
   * presented.
   */
  extractRequestMetadata?: (body: Buffer | undefined) => Extraction;
}

/**
 * Both OpenAI and Anthropic put the requested model at top-level `.model`
 * in a JSON body, along with `stream` and `max_tokens`. Echo follows the
 * same shape so tests can exercise the allow-list path without a real LLM
 * provider.
 */
function jsonRequestMetadata(body: Buffer | undefined): Extraction {
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
  // Anthropic: `max_tokens` (required). Take the first numeric we find.
  const mt = obj.max_completion_tokens ?? obj.max_tokens;
  if (typeof mt === "number" && Number.isFinite(mt) && mt >= 0) {
    meta.maxTokens = mt;
  }
  if (meta.model === undefined) return { kind: "no-model" };
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
    authStyle: "x-api-key",
    authHeader: "x-api-key",
    stripHeaders: ["host", "content-length", "connection", "authorization"],
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
