// Phase 4.1 c1 — TUI loopback HTTP client.
//
// Mirrors `web/src/api/client.ts` semantically: same endpoints, same DTOs,
// same trust posture (loopback-only). Two differences from the web client:
//
// 1. Configurable base URL. The web UI is same-origin so it uses bare
//    paths; the TUI is a separate process so every URL is absolute.
// 2. Management token lives in process memory only — no sessionStorage
//    equivalent in a terminal. When the TUI exits, the JWT is gone.
//    (Invariant 4 of the Phase 4.1 architecture memo.)
//
// Endpoint shapes are intentionally redeclared rather than imported from
// web/ — the two packages share a contract via the broker's HTTP API,
// not via TypeScript types. Keep this file in lockstep with
// web/src/api/client.ts when the contract changes.

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

export class BrokerClient {
  readonly baseUrl: string;
  private mgmtToken: string | undefined;

  constructor(baseUrl: string) {
    // Normalize: drop trailing slash so callers can pass either form.
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  setMgmtToken(token: string | undefined): void {
    this.mgmtToken = token && token.startsWith("brkm_") ? token : undefined;
  }

  hasMgmtToken(): boolean {
    return this.mgmtToken !== undefined;
  }

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as T;
  }

  fetchHealth(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>("/health");
  }

  fetchSpend(bucket: TagBucket, since: string, limit = 10): Promise<TagSpendRow[]> {
    const qs = new URLSearchParams({ bucket, since, limit: String(limit) });
    return this.getJson<TagSpendRow[]>(`/metrics/spend?${qs}`);
  }

  fetchTokens(opts?: { machine?: string }): Promise<TokenRow[]> {
    const qs = new URLSearchParams();
    if (opts?.machine) qs.set("machine", opts.machine);
    const tail = qs.toString();
    return this.getJson<TokenRow[]>(`/tokens${tail ? `?${tail}` : ""}`);
  }

  fetchAudit(opts?: {
    limit?: number;
    token?: string;
    machine?: string;
  }): Promise<AuditRow[]> {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.token) qs.set("token", opts.token);
    if (opts?.machine) qs.set("machine", opts.machine);
    const tail = qs.toString();
    return this.getJson<AuditRow[]>(`/audit${tail ? `?${tail}` : ""}`);
  }
}
