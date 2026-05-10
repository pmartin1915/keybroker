/**
 * Canonical machine-identifier normalization for the `mch` claim and any
 * `--machine` filter. Phase 3.0 — the contract Phase 2.3 deferred.
 *
 * **Rule:** trim surrounding whitespace, then lowercase the entire string.
 * Nothing more. We do NOT strip trailing dots, FQDN suffixes, or non-DNS
 * characters — both sides of the broker/dispatcher boundary must apply the
 * exact same function or they will drift, and conservative is safer than
 * clever. The dispatcher (`scripts/lib/...` in claude-budget-dispatcher)
 * already uses inline `.toLowerCase()` at every call site; this helper
 * pins the rule and gives both sides one place to mirror.
 *
 * Empty / whitespace-only input → `undefined` (the caller's signal for
 * "no machine attribution"). The empty-string semantic is load-bearing:
 * `keybroker token issue --machine ''` opts out of the claim, and
 * `verifyToken` rejects an empty-string `mch` claim, so we never let an
 * empty value reach the JWT.
 */
export function normalizeMachine(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length === 0 ? undefined : trimmed;
}
