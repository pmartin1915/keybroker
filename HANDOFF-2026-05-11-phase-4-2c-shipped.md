# Handoff — Phase 4.2c shipped (2026-05-11)

You are the next instance. This session closed out Phase 4.2 in three
commits: the 4.2b audit-gap follow-up (`7aa4655`) and Phase 4.2c
(`41c91d0`), both pushed. Working tree is clean; `origin/main` matches
local.

601 tests pass. Typecheck clean. Main web bundle 224 KB.

---

## Phase 4.2 status — DONE

| Step | Status | SHA |
|---|---|---|
| 4.2a — encoding-aware Layer 1.5 | shipped | `771ac70` |
| 4.2b — Layer 2 verify (github_pat + stripe_live_key) | shipped | `b9b945c` |
| 4.2b audit-gap follow-up — stderr warn on fail-allow + transient | shipped | `7aa4655` |
| 4.2c — AWS key-pair extraction + STS verifier (SigV4) | shipped | `41c91d0` |
| 4.1 — TUI | not started | — |
| Layer 3 (PII) | dropped permanently | — |

Phase 4.2 closes here. The next strict action is operator's choice
between **Phase 4.1 (TUI)** and **whatever's next** — the original Phase
4.2 plan is fully cleared and the open audit-shape question from 4.2b
has been answered with a stderr warning.

---

## What 4.2c ships, in one paragraph

After a Layer 1 / 1.5 hit on `aws_access_key` (`\bAKIA[0-9A-Z]{16}\b`),
the scanner now searches a 200-char bidirectional window for a paired
40-char `[A-Za-z0-9/+]` secret access key candidate. When a pair is
found, the new `ScanHit.matched_secondary` carries the secret bytes
(in-memory only); when none is found, `matched_secondary` stays
undefined and the AKIA-only block fires as before. The new
`verifyAwsKeyPair` calls STS GetCallerIdentity via home-rolled SigV4
(no `@aws-sdk` dep), records `scan_verified=1` on 200 and 0 on 403,
and throws transients up to the existing fail-policy. The dispatcher
short-circuits AKIA-only hits to `verified=null` with no network call.
Cache keys mix the pair (`sha256(akia + ":" + secret)`) so rotating
either half invalidates the entry.

---

## Decisions locked in 4.2c (don't re-litigate)

See `decision_phase_4_2_c_aws_verify.md` for the full 15. Highlights:

1.  **AKIA-only continues to fire (invariant 6).** Layer 1 block is
    unchanged. Pairing is purely additive for Layer 2 verification.
2.  **Secret-access-key regex is paired-use-only (invariant 2).** A
    standalone `[A-Za-z0-9/+]{40}` is not in `BUILTIN_DETECTORS`.
    Adding it would balloon false positives.
3.  **Pairing window: 200 chars bidirectional (invariant 3).** Stretch
    over TruffleHog's ~100 because LLM bodies are looser than the
    config files TruffleHog scans. False-positive risk stays near
    zero because the 40-char alphabet's combinatorial specificity is
    already high.
4.  **Within-view only (invariant 4).** Cross-view pairing (AKIA in
    raw, secret in base64-decoded view) is NOT supported. Real-world
    bypass class doesn't motivate it.
5.  **Home-rolled SigV4, no @aws-sdk (invariant 10).** The full SDK
    adds ~6 MB for one API call. The hand-written signer is ~150 LoC
    and is validated against AWS's documented signing-key test vector
    (the published `kSigning` hex matches).
6.  **No schema change.** The two columns from 4.2b cover AWS too.
7.  **dispatchVerify signature gained optional `secondary` (invariant
    11).** Existing github/stripe call sites unchanged. AWS verifier
    requires it; the dispatcher returns `verified=null` upstream if
    missing rather than throwing.

---

## Known gaps (carry forward)

**SHA-1 hex paired with AKIA does pair-match.** The secret-key regex
`\b[A-Za-z0-9/+]{40}\b` doesn't enforce mixed-case, so a 40-char hex
SHA next to an AKIA will pair. This is documented in
`tests/scanner.test.ts` test "SHA-1 hex near AKIA does NOT pair" as
known current behavior. Layer 2 catches it (STS returns 403
`SignatureDoesNotMatch`), so it produces `verified=0` rather than a
false positive that blocks legitimate AWS traffic. If operators
report real production false positives, tighten the regex to require
at least one uppercase letter (excludes hex) — but the layered
verification already gives the right outcome.

**aws_access_key in policy.scanner.verify.detectors but the scanner
running without aws_access_key in policy.scanner.detectors.** No
runtime warning surfaces this misconfiguration. It's not load-bearing
(if the Layer 1 detector is off, no AWS hit ever reaches the verify
dispatcher) but a sanity-check warning at policy load could prevent
operator confusion. Defer; surface only if a real operator reports it.

---

## Verify the work yourself

```sh
git log --oneline -6   # 41c91d0, 7aa4655, 5796db6, b9b945c, 9860f07, 35ebac4
npx vitest run tests/sigv4.test.ts tests/scanner.test.ts tests/verify.test.ts
npm test
```

The 8 SigV4 tests are deterministic (fixed Date inputs); a regression
in the SigV4 algorithm would flip the signing-key vector test or the
deterministic signature lock.

To smoke against real AWS (operator-only): create an IAM user with
minimal IAM privileges, set its keys in a test body, route through
the broker with verify enabled, observe `scan_verified=1` on the
audit row. Don't commit the keys.

---

## Stop-and-check-in triggers (carry forward, plus one new)

- All existing triggers from prior handoffs apply.
- **NEW:** before adding a fourth verifier (slack_bot_token,
  github_oauth, generic high-entropy, gcp_service_account), ask
  whether a real bypass class motivates it. The 4.2b and 4.2c briefs
  both deferred more verifiers deliberately. The roadmap-discipline
  bar is "do we have a documented adversary case?" — not
  "completeness."

---

## Final state

- `origin/main` = local `main`: `41c91d0` (4.2c feature, pushed).
- 601 tests, typecheck clean, main bundle 224 KB.
- Phase 4.2 closed: 4.2a + 4.2b + 4.2c shipped, audit-gap follow-up
  shipped.
- Phase 4.1 (TUI) is the unstarted remaining Phase 4 line item.

Take your time.
