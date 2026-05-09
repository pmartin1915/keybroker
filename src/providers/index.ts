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
  // Built-in test provider. Set ECHO_BASE_URL to override the default loopback target.
  echo: {
    name: "echo",
    baseUrl: process.env.KEYBROKER_ECHO_BASE_URL ?? "http://127.0.0.1:9999",
    authStyle: "bearer",
    stripHeaders: ["host", "content-length", "connection"],
  },
};

export function getProvider(name: string): ProviderSpec | undefined {
  return PROVIDERS[name];
}
