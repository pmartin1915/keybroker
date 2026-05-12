# Handoff — Phase 4.2a shipped (2026-05-11)

You are the next instance. This session implemented Phase 4.2a
(encoding-aware Layer 1.5: decode-then-scan) per the Opus-locked
invariants in `memory/decision_phase_4_2_a_decoding.md`. Sonnet 4.6
did the actual code; Opus 4.7 (this instance) reviewed the diff against
the 10 invariants and committed.

Working tree clean, **not pushed**. One commit since the prior handoff
(`9acfa0e`).

---

## What shipped

| Commit | What |
|---|---|
| `771ac70` | **feat(scanner): Phase 4.2a — decode-then-scan Layer 1.5.** New `src/decode.ts` (3 pure decoders), `scanBytes` extended to scan raw + each decoded view, 37 new tests. |

509 → 546 tests, typecheck clean, main bundle unchanged (broker-side only).

---

## What the implementation does

`src/decode.ts` exposes three decoder functions: `decodeBase64`,
`decodeUrlEncoded`, `decodeJsonStringUnescape`, plus a `DECODERS`
array in declared order. Each is a pure `(buf: Buffer) => Buffer | null`.

`src/scanner.ts:scanBytes` was extended in-place — same signature, same
return type. Internally it now: scans raw → if no hit, iterates
DECODERS, decodes once, scans the decoded view; first hit on any view
wins. Decode errors are swallowed (fail-open per invariant 5).

The `server.ts:840` call site is untouched.

### Design choices Sonnet made (Opus-approved on review)

1. **base64 candidate extraction:** regex `[A-Za-z0-9+/=_-]{16,}` to
   find candidate runs (mixed-alphabet pattern; Node's
   `Buffer.from(str, 'base64')` accepts both standard and URL-safe).
   Minimum 16 chars covers AKIA… 20-char keys when encoded.
2. **base64 garbage filter:** require ≥50% printable ASCII in the
   decoded bytes. This blocks decoder views from getting polluted by
   binary blobs (compressed/encrypted payloads that happen to round-
   trip through UTF-8). Not a security boundary — the detectors target
   specific ASCII prefixes; a real AWS key easily exceeds 50% printable
   when decoded.
3. **urlencode short-circuit:** if the body contains no `%`,
   `decodeUrlEncoded` returns null immediately. Same semantic answer
   as decoding-to-itself (no view added), faster.
4. **JSON unescape:** regex out JSON-quoted strings containing at
   least one backslash, then `JSON.parse('"' + inner + '"')` per
   match. Handles `\n \t \" \\ \uXXXX` correctly via the parser
   rather than a hand-rolled escape table.

### Tests covering the load-bearing invariants

- Invariant 2 (max 1 layer): `does NOT block base64-of-base64-encoded
  AWS key` — verified.
- Invariant 4 (no block on encoding shape alone): two tests cover
  plain text base64'd, and a JWT-shape base64 string.
- Invariant 5 (fail-open): malformed `%ZZ` urlencode does not throw
  and does not 500; raw scan path is unaffected.
- Invariant 6 (no extra fields): `Object.keys(hit) === ["detector"]`
  asserted explicitly.
- Phase 3.6 regressions: plaintext AWS / GitHub PAT still block.

---

## Decisions locked in (don't re-litigate)

1. **No new npm deps.** The prior handoff mentioned
   `@iconfu/string-decoder` as a possible choice; the research brief
   actually says "Smallest commit (one new module, no new dependencies,
   no policy changes)." Node built-ins are sufficient.
2. **50% printable-ASCII threshold** for base64 garbage. Heuristic,
   not a security boundary. Conservative.
3. **`scanBytes` signature unchanged.** Server.ts call site untouched.
4. **No audit-schema change.** `ScanHit` is still `{ detector: string }`
   and that is the only fact in the 403 / audit row.
5. **No policy.json change.** Decoders are not individually toggleable.
   If anyone wants per-decoder toggles later, that's a separate
   commit with its own decision file.

---

## Phase 4.2b — strict next action

Verification layer for **AWS only, GitHub PAT, Stripe live key**.
Read the relevant context in this order:

1. `memory/decision_phase_4_2_plan.md` — the 4.2b invariant sketch.
   Promote to its own decision file (`decision_phase_4_2_b_verify.md`)
   *before* writing code. Opus should lock the invariants first.
2. `Cowork-Phase-4.2-Research-Brief.md` §3 (B1-B3, F1-F3) — the
   verification recommendation. Latency tables, fail-policy choice,
   verify cache TTL, anomaly-detection caveats.
3. `Cowork-Phase-4.2-Research-Brief.md` §5 — the architecture diagram
   showing where Layer 2 hooks in (only on Layer 1 hit, in series,
   before audit and response).

### Likely shape

- New `src/verify.ts` with one async function per detector:
  `verifyAws(key)`, `verifyGithubPat(token)`, `verifyStripe(key)`.
  Each calls a single read-only HTTP endpoint with a 2-3s timeout
  via `undici` (already a dep).
- New schema column `scan_verified` (TINYINT NULL: 0/1/NULL). One
  migration. NULL = unchecked, 0 = verify-failed, 1 = verify-confirmed.
- New `scan_verify_latency` column (INTEGER NULL, ms). Useful for
  tuning per-detector timeouts.
- Verify cache keyed by `sha256(secret)` with 60s TTL. In-memory,
  not persisted (prevents repeat-verify spam during an attack burst).
- `policy.json` adds a `scanner.verify` block:
  ```json
  {
    "scanner": {
      "verify": {
        "enabled": true,
        "on_failure": "block",  // or "allow"
        "detectors": ["aws_access_key", "github_pat", "stripe_live_key"]
      }
    }
  }
  ```
- `outcome: 'egress_blocked'` stays terminal — no new outcome enum.
  This is invariant B3 from the research brief.

### Open questions to settle in the 4.2b Opus pass

- Verify-call attribution: should verify calls themselves be audited?
  Brief §8 suggests a separate `scanner_verify_log` table with 7-day
  TTL. Decide before coding.
- `slack_bot_token` and `github_oauth`: deliberately deferred (not
  forgotten). Pin that explicitly in the decision file.
- The anomaly-detection caveat: verify calls look like *use* to the
  upstream. AWS in particular flags STS calls from new ASNs. Document
  this in the broker README + the `policy.json` verify block.

### Estimated shape

~2–3 commits, ~400 LoC total. New module + schema migration + tests.
Per the Phase 3.2 c4 pattern, this can be done in one Opus-plan +
Sonnet-implement pass.

---

## State of related repos

- **keybroker:** clean at `771ac70`. 546 tests pass.
- **claude-budget-dispatcher:** unchanged this session. The Phase 3.2
  c4 broker routing change in `provider.mjs` is still opt-in; flipping
  `KEYBROKER_ROUTE` default-on is a one-line dispatcher change whenever
  the user wants it. The 4.2a decoder doesn't change that calculus.

---

## Useful commands

```sh
# verify Phase 4.2a is in
git log --oneline -4   # 35ebac4, 771ac70, 9acfa0e, 76d2855

# run just the new tests
npx vitest run tests/decode.test.ts

# full suite
npm test
```

---

## Stop-and-check-in triggers (carry forward, plus one new)

- All existing triggers from prior handoffs apply.
- **NEW:** before adding a fourth decoder (UTF-16, gzip, hex, etc.),
  ask whether a real bypass class motivates it. The brief's "Open
  question §8.3" on UTF-16 is explicitly deferred: AWS / GitHub /
  Stripe keys are ASCII-only, so UTF-16 wrapping has no detection
  payoff. Layer 1.5 expansion needs a real adversary case, not a
  completeness urge.
- **NEW:** before adding a `keybroker scanner test <body-fixture>`
  CLI (brief §8.5), check whether operators have actually asked for
  it. Park for 4.2c.

---

## Final state

- `origin/main` (remote): `9acfa0e` (last push was the prior handoff).
- Local `main` = `origin/main`: `35ebac4` (handoff) atop `771ac70` (4.2a feature). **Pushed.**
- 546 tests, typecheck clean, main bundle 224 KB (web unchanged).
- Phase 4.2a: **shipped, awaiting push.**
- Phase 4.2b: **next strict action.** Opus should lock invariants
  in a fresh `decision_phase_4_2_b_verify.md` before delegating to
  Sonnet.

Take your time. The push decision is yours — the prior session's
pattern was commit-and-push together, but I held off because the
session prompt did not explicitly authorize a push.
