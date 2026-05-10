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
   * Inspect the upstream request body and return the requested model name,
   * or undefined if the body has no parseable model field. Defining this
   * field marks the provider as supporting per-token model allow-lists
   * (the `mdl` claim); providers without it cannot be issued tokens with
   * --model restrictions and will be rejected at `token issue` time.
   */
  extractRequestedModel?: (body: Buffer | undefined) => string | undefined;
}

/**
 * Both OpenAI and Anthropic put the requested model at top-level `.model`
 * in a JSON body. Echo follows the same shape so tests can exercise the
 * model-allowlist path without a real LLM provider.
 */
function jsonBodyModel(body: Buffer | undefined): string | undefined {
  if (!body || body.byteLength === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      const m = (parsed as { model: unknown }).model;
      if (typeof m === "string" && m.length > 0) return m;
    }
  } catch {
    // Non-JSON body (e.g. multipart upload to /v1/files) — caller treats
    // "no extractable model" as deny when mdl is set; that's the safe default.
  }
  return undefined;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com",
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
    extractRequestedModel: jsonBodyModel,
  },
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "x-api-key",
    authHeader: "x-api-key",
    stripHeaders: ["host", "content-length", "connection", "authorization"],
    extractRequestedModel: jsonBodyModel,
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
    extractRequestedModel: jsonBodyModel,
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
