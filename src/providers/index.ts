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
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    name: "openai",
    baseUrl: "https://api.openai.com",
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
  },
  anthropic: {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authStyle: "x-api-key",
    authHeader: "x-api-key",
    stripHeaders: ["host", "content-length", "connection", "authorization"],
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
