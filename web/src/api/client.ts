// Thin fetch wrappers for the broker's open-on-127.0.0.1 dashboard
// routes. No auth header: same trust posture as `curl localhost:7843/health`
// from the CLI — the broker binds 127.0.0.1 only.

export interface HealthResponse {
  keybroker_ok: boolean;
  ok: boolean;
  version: string;
  tokens: { active: number; revoked: number; total: number };
  calls: {
    last24h: number;
    last24hSpendUsd: number;
    last24hSpendUsdByMachine: Record<string, number>;
  };
}

export interface TagSpendRow {
  key: string;
  usd: number;
  callCount: number;
}

export type TagBucket = "team" | "project" | "env";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/health");
}

export function fetchSpend(
  bucket: TagBucket,
  since: string,
  limit = 10,
): Promise<TagSpendRow[]> {
  const qs = new URLSearchParams({ bucket, since, limit: String(limit) });
  return getJson<TagSpendRow[]>(`/metrics/spend?${qs}`);
}
