export interface CallLogEntry {
  ts: string;
  tokenId: string;
  label: string;
  provider: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Bytes sent upstream in request body. */
  reqBytes: number;
  /** Bytes received from upstream. */
  respBytes: number;
  /** Empty unless an outcome != "ok" occurred. */
  outcome: "ok" | "denied" | "error";
  reason?: string;
  /**
   * Model the client requested in the body (Phase 2.1). Populated on
   * model-allow-list denials so audit consumers can group/query by model
   * without parsing the `reason` string. Phase 2.2 will populate this on
   * successful calls too, alongside a separate `servedModel` for
   * billing-accurate (alias-resolved) reporting.
   */
  requestedModel?: string;
  /**
   * Phase 2.3: machine that issued the calling token (from the `mch` claim).
   * Absent on calls made with pre-2.3 tokens that have no claim.
   */
  machine?: string;
  /**
   * Phase 2.2: pre-flight USD cost estimate for this call (when the token has
   * a cap, OR when the model is priced and the operator wants visibility).
   * Computed from `pricing.estimateCostUsd(model, maxTokens)`. Absent for
   * unpriced models or for calls denied before the cap branch fires.
   */
  estimatedCostUsd?: number;
  /**
   * Phase 2.2: actual USD cost reconciled from upstream `usage`. Absent when
   * the upstream did not return usage (e.g. SSE without
   * `stream_options.include_usage`, or the echo provider in tests). When
   * absent, treat `estimatedCostUsd` as the spend for cap accounting.
   */
  actualCostUsd?: number;
}
