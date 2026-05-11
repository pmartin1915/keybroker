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
  /**
   * Empty unless an outcome != "ok" occurred.
   *
   * Values:
   *   - `"ok"`: upstream returned successfully.
   *   - `"denied"`: token/scope/policy/model check refused the call.
   *     `reason` carries the specific deny kind (`scope_denied`,
   *     `model_forbidden`, etc.).
   *   - `"error"`: upstream returned non-2xx or the proxy itself failed
   *     mid-stream. `reason` is the upstream status or a short label.
   *   - `"egress_blocked"` (Phase 3.6): inline scanner caught a secret
   *     in the request body. The call was NOT dialled out. `reason`
   *     carries the detector name (e.g. `"aws_access_key"`) and never
   *     the matched substring.
   */
  outcome: "ok" | "denied" | "error" | "egress_blocked";
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
  /**
   * Phase 3.3: tag attribution carried from the JWT's `tag` claim into
   * the audit log. Each subkey is independently optional. Absent on
   * calls made with pre-3.3 tokens. The audit log is the source of
   * truth for FinOps queries (Phase 3.4) — tag aggregation runs over
   * these columns, not the tokens table.
   */
  tagTeam?: string;
  tagProject?: string;
  tagEnv?: string;
  /**
   * Phase 3.7: latency split. Three optional fields so the schema is
   * back-compat with pre-3.7 rows (denied / error / pre-migration).
   *
   *   - `ttftMs`: time-to-first-byte, measured from request-send to
   *     the first chunk emitted by the upstream body stream. For non-
   *     streaming responses (single buffered chunk) this still
   *     measures the prefill latency reported by undici. Absent when
   *     the request never reached upstream (denied / egress_blocked /
   *     pre-flight error) — i.e. the same rows where `respBytes === 0`.
   *   - `tpotMsAvg`: mean inter-token latency over the streaming
   *     portion, computed as `(finishTime - firstByteTime) /
   *     outputTokens`. Absent when `outputTokens` is undefined or
   *     zero (single-byte responses divide-by-zero into Infinity;
   *     skipping is cleaner than emitting a sentinel).
   *   - `outputTokens`: completion-tokens / output_tokens reported by
   *     the upstream usage event. Same provenance as `actualCostUsd`
   *     — populated only when `parseUsageFromUpstream` returns a hit.
   *
   * The trio is the input for the prototype's stacked-bar waterfall
   * (prefill / decode / total). FinOps p50/p95 dashboards run over
   * `ttftMs` and `tpotMsAvg` columns directly (Phase 3.7's
   * /metrics/latency endpoint).
   */
  ttftMs?: number;
  tpotMsAvg?: number;
  outputTokens?: number;
}
