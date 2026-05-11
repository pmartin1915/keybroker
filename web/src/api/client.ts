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

// Phase 4.0 c2: mirrors broker `TokenRecord` (src/store-types.ts) plus
// the `spendUsd` field the /tokens endpoint augments each record with.
// Optional fields stay optional — older records may lack them.
export interface TokenRow {
  id: string;
  provider: string;
  scopes: string[];
  remaining: number;
  used: number;
  expiresAt: number;
  createdAt: string;
  label: string;
  revoked: boolean;
  machine?: string;
  capUsd?: number;
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
  models?: string[];
  spendUsd: number;
}

// Phase 4.0 c2: mirrors broker `CallLogEntry` (src/logging.ts).
export interface AuditRow {
  ts: string;
  tokenId: string;
  label: string;
  provider: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  reqBytes: number;
  respBytes: number;
  outcome: "ok" | "denied" | "error" | "egress_blocked";
  reason?: string;
  requestedModel?: string;
  machine?: string;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
  ttftMs?: number;
  tpotMsAvg?: number;
  outputTokens?: number;
}

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

export function fetchTokens(opts?: { machine?: string }): Promise<TokenRow[]> {
  const qs = new URLSearchParams();
  if (opts?.machine) qs.set("machine", opts.machine);
  const tail = qs.toString();
  return getJson<TokenRow[]>(`/tokens${tail ? `?${tail}` : ""}`);
}

export function fetchAudit(opts?: {
  limit?: number;
  token?: string;
  machine?: string;
}): Promise<AuditRow[]> {
  const qs = new URLSearchParams();
  if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts?.token) qs.set("token", opts.token);
  if (opts?.machine) qs.set("machine", opts.machine);
  const tail = qs.toString();
  return getJson<AuditRow[]>(`/audit${tail ? `?${tail}` : ""}`);
}
