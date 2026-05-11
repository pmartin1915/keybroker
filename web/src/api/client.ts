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

// Phase 4.0 c3: mirrors broker `TokenForecastRow` (src/server.ts).
export interface TokenForecastRow {
  tokenId: string;
  label: string;
  provider: string;
  slopeUsdPerDay: number;
  interceptUsd: number;
  currentUsd: number;
  daysUntilCap?: number;
  projectedCapBreachDate?: string;
  capUsd?: number;
  machine?: string;
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
}

export interface TagForecastRow {
  key: string;
  slopeUsdPerDay: number;
  currentUsd: number;
}

export interface ScannerConfig {
  enabled: boolean;
  detectors?: readonly string[];
}

export interface PolicySnapshot {
  forbiddenModels: readonly string[];
  allowedProviders: readonly string[];
  tagAllowlist: {
    team?: readonly string[];
    project?: readonly string[];
    env?: readonly string[];
  };
  scanner: ScannerConfig;
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

export function fetchTokenForecast(opts?: {
  since?: string;
  top?: number;
}): Promise<TokenForecastRow[]> {
  const qs = new URLSearchParams();
  if (opts?.since) qs.set("since", opts.since);
  if (opts?.top !== undefined) qs.set("top", String(opts.top));
  const tail = qs.toString();
  return getJson<TokenForecastRow[]>(`/forecast/tokens${tail ? `?${tail}` : ""}`);
}

export function fetchTagForecast(
  bucket: TagBucket,
  opts?: { since?: string; top?: number },
): Promise<TagForecastRow[]> {
  const qs = new URLSearchParams({ bucket });
  if (opts?.since) qs.set("since", opts.since);
  if (opts?.top !== undefined) qs.set("top", String(opts.top));
  return getJson<TagForecastRow[]>(`/forecast/tags?${qs}`);
}

export function fetchPolicy(): Promise<PolicySnapshot> {
  return getJson<PolicySnapshot>("/policy");
}

// ─────────────────────────────────────────────────────────────────────
// Phase 4.0 c4: management surface. Admin routes mutate state, so they
// sit behind a separate signing secret (`config.mgmtSecret`) and the
// client is expected to present a `brkm_` JWT minted via
// `keybroker token mgmt --issue`.
//
// The token lives in sessionStorage so a refresh keeps it but closing
// the tab drops it — short blast radius if a session is left open on
// a shared machine. We never persist it to localStorage and never log
// it. The actual JWT bytes leave the page only via the Authorization
// header on outbound /admin/* requests.
// ─────────────────────────────────────────────────────────────────────

const MGMT_TOKEN_STORAGE_KEY = "keybroker.mgmtToken";

export function getMgmtToken(): string | undefined {
  try {
    const raw = sessionStorage.getItem(MGMT_TOKEN_STORAGE_KEY);
    if (!raw) return undefined;
    // Defence-in-depth: only return tokens with the expected prefix so a
    // stale localStorage value (or a manually-set garbage one) doesn't
    // surface as an Authorization header.
    return raw.startsWith("brkm_") ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function setMgmtToken(token: string): void {
  try {
    sessionStorage.setItem(MGMT_TOKEN_STORAGE_KEY, token);
  } catch {
    // sessionStorage might be disabled (private mode, certain embeds).
    // Silently drop — the screen will prompt for the token next time.
  }
}

export function clearMgmtToken(): void {
  try {
    sessionStorage.removeItem(MGMT_TOKEN_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Phase 4.0 c4: structured error thrown when an admin call needs a
 * management token (either none is presented or the broker rejected
 * the one we sent). Screens catch this specifically and surface the
 * "set management token" prompt; everything else gets generic error
 * rendering.
 */
export class MgmtAuthError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MgmtAuthError";
    this.status = status;
  }
}

async function adminFetch<T>(
  method: "POST" | "DELETE",
  url: string,
  body?: unknown,
): Promise<T> {
  const tok = getMgmtToken();
  if (!tok) {
    throw new MgmtAuthError("no management token set", 401);
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${tok}`,
    accept: "application/json",
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // The cached token is bad; force a re-prompt on the next attempt.
    clearMgmtToken();
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
    throw new Error(`${method} ${url} failed: ${tag}${hint}`);
  }
  return (await res.json()) as T;
}

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

export function issueProxyToken(body: IssueTokenBody): Promise<IssueTokenResponse> {
  return adminFetch<IssueTokenResponse>("POST", "/admin/tokens", body);
}

export interface RevokeTokenResponse {
  revoked: true;
  id: string;
  alreadyRevoked?: boolean;
}

export function revokeProxyToken(id: string): Promise<RevokeTokenResponse> {
  return adminFetch<RevokeTokenResponse>("DELETE", `/admin/tokens/${encodeURIComponent(id)}`);
}

export interface RotateFilters {
  team?: string;
  project?: string;
  env?: string;
  machine?: string;
  provider?: string;
}

export interface RotatePreview {
  filters: RotateFilters;
  preview: {
    total: number;
    byMachine: Record<string, number>;
    byTeam: Record<string, number>;
    byProject: Record<string, number>;
    byEnv: Record<string, number>;
  };
}

export interface RotateDryRun {
  filters: RotateFilters;
  plan: Array<{
    oldId: string;
    newId: string;
    label: string;
    noModelsClaim: boolean;
  }>;
  expired: Array<{ id: string; label: string }>;
}

export interface RotateResult {
  filters: RotateFilters;
  revoked: number;
  reissued: Array<{
    oldId: string;
    newId: string;
    label: string;
    jwt: string;
    noModelsClaim: boolean;
  }>;
  expired: Array<{ id: string; label: string }>;
}

export function rotatePreview(filters: RotateFilters): Promise<RotatePreview> {
  return adminFetch<RotatePreview>("POST", "/admin/tokens/rotate", {
    filters,
    preview: true,
  });
}

export function rotateDryRun(filters: RotateFilters): Promise<RotateDryRun> {
  return adminFetch<RotateDryRun>("POST", "/admin/tokens/rotate", {
    filters,
    dryRun: true,
  });
}

export function rotateExecute(filters: RotateFilters): Promise<RotateResult> {
  return adminFetch<RotateResult>("POST", "/admin/tokens/rotate", { filters });
}

/**
 * Phase 4.0 c4: validate a management token by hitting an admin route
 * with a guaranteed-no-op body. We use POST /admin/tokens/rotate with
 * an empty filters object, which the broker rejects with 400
 * `no_filters` when auth passes — confirming the token is valid
 * without mutating anything. A 401 means the token is bad.
 */
export async function probeMgmtToken(token: string): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    const res = await fetch("/admin/tokens/rotate", {
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
    // Any other status means something unexpected happened; treat as
    // not-ok so we don't lock in a token under suspicious server state.
    return { ok: false, reason: `unexpected_${res.status}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
