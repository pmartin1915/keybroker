# Handoff — Phase 4.2b shipped (2026-05-11)

You are the next instance. This session shipped Phase 4.2a AND
Phase 4.2b in one sitting. Phase 4.2a (encoding-aware Layer 1.5)
landed in `771ac70` (pushed) and Phase 4.2b (Layer 2 verification)
in `b9b945c` (pushed).

Working tree clean. `origin/main` matches local. 571 tests pass,
typecheck clean.

---

## Phase 4.2 status

| Step | Status | SHA |
|---|---|---|
| 4.2a — encoding-aware Layer 1.5 (decode-then-scan) | shipped | `771ac70` |
| 4.2b — Layer 2 verification (github_pat + stripe_live_key) | shipped | `b9b945c` |
| 4.2c — AWS verifier (deferred; needs key-pair extraction) | not started | — |
| 4.1 — TUI | not started | — |
| Layer 3 (PII) | dropped permanently | — |

The original Phase 4.2 plan's prerequisite chain is fully cleared.
Next strict action is operator's choice between 4.2c (close the AWS
verification gap) and 4.1 (TUI for the bundled UI).

---

## What 4.2b ships, in one paragraph

After a Layer 1/1.5 regex hit, the broker calls the upstream's
read-only verify endpoint (`GET api.github.com/user` for ghp_*,
`GET api.stripe.com/v1/balance` for sk_live_*) with a 2.5s timeout.
A live response (200) records `scan_verified=1` on the audit row; an
auth-failure (401/403) records `scan_verified=0`; transient errors
(timeout / 5xx / network) record `scan_verified=0` under the default
fail-CLOSED policy OR forward the request silently under operator-
configured `on_failure: "allow"`. An in-memory sha256-keyed cache
(60s TTL, positive + negative results, transient failures NOT cached)
prevents attack-burst from hammering upstream rate-limits. The
matched secret bytes never leave the request-handler stack — cache
key is `sha256(secret)`, not the secret itself.

The two columns on `calls` (`scan_verified` INTEGER NULL,
`scan_verify_latency_ms` INTEGER NULL) are added via the established
`addColumnIfMissing` migration pattern. Existing audit rows from
pre-4.2b traffic keep `scan_verified=NULL` forever, which is the
correct "unchecked" semantic.

---

## Known gap (carry forward to next instance)

**Fail-allow + transient verifier failure leaves no audit signal.**
When `on_failure: "allow"` is set and the verifier throws (timeout,
5xx, network), the request is forwarded silently. There is no audit
row recording "we detected a hit but allowed it through" — the
normal upstream call row gets written with no scan info.

Operationally this means an operator who flips `on_failure="allow"`
and then sees their LLM costs climb cannot tell whether their scanner
is silently letting hits through during upstream outages. It is the
operator-surprising path Sonnet flagged at implementation time.

**Suggested fix (small, deferrable):** add a `console.warn` line in
`dispatchVerify`'s catch block when `cfg.on_failure === "allow"`:

```ts
console.warn(
  `keybroker: scanner.verify detector=${detector} failed transiently; ` +
  `on_failure=allow → forwarding request. ` +
  `latency_ms=${latencyMs}`,
);
```

No secret bytes in the message. ~5 LoC including a test. Could
plausibly ship as the next commit, or roll into 4.2c.

**Why not in this commit:** the invariant lock said "Default fail-
CLOSED ... operator can opt to fail-allow." It didn't address the
observability shape of the allow path. The right place to make that
call is a follow-up Opus pass that thinks about audit shape
specifically, not a tactical Sonnet edit.

---

## Decisions locked in this session (don't re-litigate)

1. **AWS deferred from 4.2b** because STS GetCallerIdentity needs the
   AWS access key ID + secret access key pair, and our scanner only
   detects the AKIA prefix. Extending the scanner to detect key
   PAIRS within proximity is a separate architectural decision —
   that's Phase 4.2c's job. Brief §3 F2 was written without checking
   this technical reality; Opus override documented in
   `decision_phase_4_2_b_verify.md` invariant 2.

2. **fail-CLOSED is the DEFAULT, not just "recommended".** Brief F3
   said "fail-policy per detector, recommended default fail-closed."
   Opus made it the literal default and made the policy global (not
   per-detector) for 4.2b. Per-detector configurability is a follow-
   up if operators report needing it.

3. **No `scanner_verify_log` separate table.** Brief §8 suggested
   one with a 7-day TTL. Opus override: two columns on `calls` are
   sufficient attribution. The "pollutes audit log with non-user
   traffic" concern doesn't apply because we're adding COLUMNS not
   ROWS.

4. **Verify timeout 2.5s, not configurable in 4.2b.** Below GitHub's
   documented 10s server timeout so we fail-fast. If operators report
   tuning needs after running the broker in production, promote to
   `policy.json`. Not pre-built.

5. **No new npm dependencies.** `fetch`, `crypto`, `AbortSignal` are
   all Node built-ins on Node 20+. The brief's TruffleHog discussion
   was settled in §3 B2 ("write 2-3 verifier functions in TypeScript
   directly"); 4.2b honored that.

6. **Test fixtures use concat-split convention.** GitHub push-
   protection scans both code AND comments. Synthetic test keys must
   split the prefix across `+` (`"ghp_" + "a".repeat(36)`) and
   comments must use placeholders (`"sk_live_<24+chars>"`). The
   4.2a commit went through a soft-reset rebase because Sonnet's
   first pass embedded full fixture strings; 4.2b avoided this from
   the start. Pin this convention in any future commit briefs.

---

## State of related repos

- **keybroker:** clean at `b9b945c`. 571 tests, typecheck clean,
  main bundle 224 KB.
- **claude-budget-dispatcher:** unchanged this session. The Phase
  3.2 c4 broker routing in `provider.mjs` is still opt-in. Flipping
  `KEYBROKER_ROUTE` default-on is a one-line dispatcher change
  whenever the user wants it; 4.2b doesn't change that calculus
  (verification is broker-side, transparent to the dispatcher).

---

## Verify the work yourself

```sh
# verify shipped
git log --oneline -5   # b9b945c, 9860f07, 35ebac4, 771ac70, 9acfa0e

# unit tests only
npx vitest run tests/verify.test.ts

# integration with scanner
npx vitest run tests/scanner.test.ts tests/decode.test.ts tests/verify.test.ts

# full suite
npm test
```

The broker can be brought up to poke at the UI / audit view:

```sh
npx tsx src/cli.ts serve   # :8787
# then http://127.0.0.1:8787/ui/
```

The Audit screen does NOT yet have a "verified" filter pill or
column — that's a follow-up UI commit that's blocked on real
`scan_verified` data in someone's local DB. Not strictly needed for
4.2b ship, but a quick win once an operator has a few hits.

---

## Phase 4.2c — strict next action (if chosen)

AWS verification, requiring access-key-pair extraction.

**Scope sketch (do NOT lock invariants yet; that's a fresh Opus
pass):**

1. **Scanner extension:** the existing `aws_access_key` detector
   only matches `AKIA[0-9A-Z]{16}`. Phase 4.2c needs a paired
   regex for the AWS secret access key (40 chars, base64-ish
   alphabet `[A-Za-z0-9/+=]`). Within the same request body, an
   AKIA hit AND a paired secret within N bytes (TruffleHog uses
   100 chars) constitutes a verifiable pair. The scanner result
   shape needs to carry BOTH bytes for AWS.
2. **AWS verifier:** STS `GetCallerIdentity` requires AWS
   Signature v4 — that's HMAC-SHA256 over a canonical request
   string with timestamp + region. It's not trivial but the
   algorithm is published. ~150 LoC of crypto. Or:
   ditch the home-rolled signer and use the @aws-sdk/client-sts
   package — but that's a substantial new dep (~6 MB) for a
   single API call. Likely the right call is the home-rolled
   signer (no new deps), but the trade-off should be re-examined
   when the 4.2c Opus pass happens.
3. **Schema:** no migration needed. The two columns added in
   4.2b cover AWS too.
4. **Policy:** the verify allow-list grows to
   `["aws_access_key", "github_pat", "stripe_live_key"]` —
   one-line `DEFAULT_VERIFY.detectors` update.

Estimated shape: 1 commit, ~300 LoC (scanner + verifier + tests),
no schema change.

---

## Stop-and-check-in triggers (carry forward, plus two new)

- All existing triggers from prior handoffs apply.
- **NEW:** before adding a new verifier (slack_bot_token,
  github_oauth, generic), ask whether a real bypass class motivates
  it. The brief's F2 deferred both deliberately; adding either
  needs a real adversary case, not a completeness urge.
- **NEW:** before adding per-detector `on_failure` policy or per-
  detector verify timeout, ask whether an operator has hit the
  global-only constraint in real usage. 4.2b invariants 8 + 10
  explicitly punt these; they should not be pre-built.

---

## Final state

- `origin/main` = local `main`: `b9b945c` (4.2b feature, pushed).
- 571 tests, typecheck clean, main bundle 224 KB (web unchanged).
- Phase 4.2a + 4.2b: **shipped, pushed.**
- Phase 4.2c (AWS verifier) and Phase 4.1 (TUI) both unstarted —
  operator's call which comes next.

Take your time. The fail-allow audit gap (above) is the one open
operational concern; everything else is forward-disciplined and
deferred-with-reason.
