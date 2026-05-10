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
}
