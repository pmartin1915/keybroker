import { appendFileSync } from "node:fs";

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
}

export function appendCall(path: string, entry: CallLogEntry): void {
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
