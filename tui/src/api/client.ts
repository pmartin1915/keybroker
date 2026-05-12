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

// Phase 4.1 c4: structured error for admin-side calls. Mirrors web's
// MgmtAuthError so callers can branch on auth-needed without parsing
// strings. The screen catches this and pushes the mgmt-prompt modal.
export class MgmtAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MgmtAuthError";
    this.status = status;
  }
}

// Phase 4.1 c4: admin DTOs. Shape mirrors web/src/api/client.ts. Kept
// intentionally redeclared (not imported) — the two packages share a
// contract via the broker HTTP API, not via TypeScript types.
export interface IssueTokenBody {
  provider: string;
  scopes?: string[];
  label?: string;
  ttlSeconds?: number;
  maxCalls?: number;
  models?: string[];
  machine?: string;
  capUsd?: number;
  tags?: { team?: string; project?: string; env?: string };
}

export interface IssueTokenResponse {
  tokenId: string;
  jwt: string;
  record: TokenRow;
}

export interface RevokeTokenResponse {
  revoked: true;
  id: string;
  alreadyRevoked?: boolean;
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

  clearMgmtToken(): void {
    this.mgmtToken = undefined;
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

  // Phase 4.1 c4: admin-side fetch. Throws MgmtAuthError on 401 (and
  // drops the cached token so the next attempt re-prompts), wraps all
  // other non-2xx responses in Error with the broker's `error`/`hint`
  // payload tags. Mirrors web/'s adminFetch.
  private async adminFetch<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.mgmtToken) {
      throw new MgmtAuthError("no management token set", 401);
    }
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.mgmtToken}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // Cached token is bad — drop it so the next call re-prompts.
      this.mgmtToken = undefined;
      const detail = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      throw new MgmtAuthError(
        detail.error ?? "invalid_management_token",
        res.status,
      );
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as {
        error?: string;
        hint?: string;
      };
      const tag = detail.error ?? `${res.status} ${res.statusText}`;
      const hint = detail.hint ? ` — ${detail.hint}` : "";
      throw new Error(`${method} ${path} failed: ${tag}${hint}`);
    }
    return (await res.json()) as T;
  }

  // Phase 4.1 c4: validate a candidate mgmt token without committing it
  // to the client. POST /admin/tokens/rotate with empty filters — broker
  // returns 400 `no_filters` when auth passes (no mutation, no audit
  // pollution). 401 means the token is bad. Mirrors web's probeMgmtToken.
  async probeMgmtToken(
    token: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!token.startsWith("brkm_")) {
      return { ok: false, reason: "missing_brkm_prefix" };
    }
    try {
      const res = await fetch(`${this.baseUrl}/admin/tokens/rotate`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ filters: {} }),
      });
      if (res.status === 401) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, reason: body.error ?? "invalid_management_token" };
      }
      if (res.status === 400) {
        // Expected: `no_filters` — confirms auth passed.
        return { ok: true };
      }
      return { ok: false, reason: `unexpected_${res.status}` };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  issueProxyToken(body: IssueTokenBody): Promise<IssueTokenResponse> {
    return this.adminFetch<IssueTokenResponse>("POST", "/admin/tokens", body);
  }

  revokeProxyToken(id: string): Promise<RevokeTokenResponse> {
    return this.adminFetch<RevokeTokenResponse>(
      "DELETE",
      `/admin/tokens/${encodeURIComponent(id)}`,
    );
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
