# Handoff — keybroker Phase 4.2 planning locked (2026-05-11)

You are the next instance. Phase 4.0 closed earlier this session
(commit `5103557`). The user then ran a Cowork session against the
Phase 4.2 research prompt drafted in this conversation; the output
is `Cowork-Phase-4.2-Research-Brief.md` at repo root. The user
accepted the brief modulo two Opus tuning notes. This handoff
captures the locked plan.

Working tree includes this handoff (and possibly an updated
`Cowork-Phase-4.2-Research-Brief.md`) on top of `origin/main` at
`5103557`. Memory has been updated with two new decision files.

---

## Read these first (in order)

1. **`Cowork-Phase-4.2-Research-Brief.md`** (repo root) — the
   canonical research brief. Architecture, citations, competitive
   landscape, decoder choice rationale, verifier latencies.
2. **`memory/decision_phase_4_2_plan.md`** — Phase-wide plan with
   the 4.2b invariant sketch.
3. **`memory/decision_phase_4_2_a_decoding.md`** — 10 firm
   invariants for the next implementation commit.
4. `HANDOFF-2026-05-11-phase-4-0-closeout.md` for context on what
   Phase 4.0 shipped.

---

## The locked sequence

| Step | Phase | Who drives | What |
|---|---|---|---|
| 1 | 3.2 c4 dispatcher smoke | User + Opus | Real Gemini + Mistral keys, ~15 min, verifies `KEYBROKER_ROUTE=1` actually routes SDK calls through the broker. Has been pending since Phase 3.2. **Prerequisite to any 4.2 code.** |
| 2 | 4.2a | Opus locks → Sonnet implements | Encoding-aware Layer 1.5 (decode-then-scan). New `src/decode.ts`, light edits to `src/scanner.ts` and tests. ~1 commit, ~200 LoC, no schema change, no policy change. |
| 3 | 4.2b | Opus locks → Sonnet implements (probably 3 sub-commits) | Verification for AWS / GitHub PAT / Stripe live key. New `src/scanner-verify.ts`, audit-schema migration adding `scan_verified` + `scan_verify_latency_ms`, Audit UI "Verified only" filter toggle. |
| 4 | 4.2 closeout | Opus | Update wedge story to "verified secret blocking on a laptop." Final 4.2 handoff. Possibly tag. |
| 5 | 4.1 | TBD | TUI variant. Defense (4.2) before depth (4.1) — that's the brief's reordering. |

**Layer 3 PII is dropped entirely from Phase 4.2.** Per brief
§4 C1-C3 and anti-roadmap discipline: PII detectors need
Python/spaCy or transformer deps incompatible with the one-Node-
binary posture, it changes the pitch from credential broker to
DLP gateway, and keybroker has no compliance buyer yet. If a real
user asks, build it then.

---

## The two Opus notes against the brief

Both promoted into the decision files. Capturing here for diffing
against the brief if a future instance revisits.

1. **Layer 1.5 never 403s on encoding shape alone.** Brief left it
   as open question §8.3 with openness to "yes, 403 on nested
   encoding even without a hit." Opus override: no. Intent-based
   classification ("looks adversarial") is the prompt-injection-
   detection problem Hard Constraint #5 excludes. Mermaid diagrams,
   JWTs, signed assets all contain base64-looking strings. Layer
   1.5 is decode-then-Layer-1, full stop. Locked as invariant 4 in
   `decision_phase_4_2_a_decoding.md`.

2. **Verify cache TTL is 300s, not the brief's 60s.** Stripe and
   GitHub rate-limit aggressively; a retry storm against a single
   leaked key could spike verify calls 1000x. 60s is too tight.
   Tuning detail, not architectural. Pinned in the 4.2b sketch in
   `decision_phase_4_2_plan.md` §F.5; will be locked into
   `decision_phase_4_2_b_verify.md` when 4.2b is delegated.

---

## What the next instance should do

**If user has Gemini + Mistral keys available:** drive the Phase
3.2 c4 dispatcher smoke. Recipe is in
`HANDOFF-2026-05-10-phase-3-2-commit-4.md`. ~15 minutes. Document
results in a one-paragraph commit message; no design.

**If keys aren't immediately available:** the user has already
signalled "smoke first, before 4.2a code." Don't try to skip ahead
to 4.2a. Either wait, or use the session for orthogonal cleanup
work that doesn't depend on the routed dispatcher path.

**After smoke clears:** delegate 4.2a to a Sonnet 4.6 subagent
using the prompt template at the bottom of
`decision_phase_4_2_a_decoding.md`. Opus reviews diff against
invariants 1-10 before committing. Same pattern that worked for c4e.

---

## Architecture pin (from brief §5)

```
Inbound request
  → verify brk_ JWT
  → policy gate
  → model gate
  → build body buffer
  → [4.2a] decode wrappers (raw + decoded views)
  → [3.6] Layer 1 regex scan, first-hit-wins across all views
    → no hit → forward upstream
    → hit:
      → [4.2b] if verify enabled for this detector:
        → live verify call (200/401/timeout)
        → cache result by sha256(secret), 300s TTL
        → block / allow per outcome + fail-policy
      → else: block with verified=NULL
  → record audit (calls or admin_audit)
```

Layer 1.5 hits decoded view? Verify call (4.2b) targets the
*decoded* secret, not the raw encoded substring. Forward-pinned
in 4.2a invariant 10.

---

## Carry-forward invariants (still load-bearing)

All Phase 4.0 invariants from
`HANDOFF-2026-05-11-phase-4-0-closeout.md` carry forward. New
4.2-specific:

- **Decoded substring is the secret, never logged.** Phase 3.6
  invariant 1 extends to decoded views. The matched substring on
  either raw or decoded view defeats the scanner if logged.
- **Default-on, fail-OPEN-OPEN.** Phase 3.6 invariants 2 + 3
  extend across 4.2a and 4.2b. Decoder errors fail open; verify
  errors fail per policy (default fail-closed, but operator can
  override per detector).
- **Body re-serialization trap (memory `trap_body_reserialization.md`).**
  Layer 1.5 and Layer 2 must operate on the same byte buffer the
  broker forwards upstream. Already true for Layer 1.

---

## Final state at this handoff

- `origin/main` at `5103557` (Phase 4.0 closeout, pushed).
- Phase 4.0 CLOSED. Phase 4.2 plan locked. No code yet for 4.2.
- 508 tests pass, both typechecks clean.
- Three new memory files: `decision_phase_4_2_plan.md`,
  `decision_phase_4_2_a_decoding.md`, plus this handoff in repo.
- `Cowork-Phase-4.2-Research-Brief.md` in repo root is canonical
  reference for the phase.
- **Next action: Phase 3.2 c4 dispatcher smoke.** Blocked on user
  having real Gemini + Mistral keys available.

Take your time. Do not start 4.2a until the smoke clears.
