# Handoff — keybroker Phase 3.6 complete (2026-05-10)

You are the next instance. Phase 3.6 — inline secret scanning, the
headline differentiator from the plan's strategic positioning — shipped
as a single commit on this turn. Working tree should be clean after the
commit. Phase 3.2 commit 4 (the dispatcher work) shipped earlier today;
see `HANDOFF-2026-05-10-phase-3-2-commit-4.md` for that context.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Scanner module | `src/scanner.ts` (new) | `BUILTIN_DETECTORS` (5 patterns: aws_access_key, github_pat, github_oauth, slack_bot_token, stripe_live_key), `scanBytes(buf, detectors)`, `resolveDetectors(enabled, names)`, `getBuiltinDetector(name)`. Pure module — no I/O, no globals. |
| Audit outcome | `src/logging.ts` | `outcome` union widened from `"ok" \| "denied" \| "error"` to add `"egress_blocked"`. Distinct from `"denied"` so FinOps queries can partition cleanly. |
| Policy schema | `src/policy.ts` | New `ScannerConfig { enabled, detectors? }`. Normalize accepts `policy.json.scanner = { enabled: bool, detectors?: string[] }`. Fail-OPEN-OPEN: missing key OR malformed value → default-on with all built-ins. Operators opt out with `{"enabled": false}`. |
| Server hook | `src/server.ts:266+` | After `bodyBuf` is built and after `provider_forbidden` check, scan body with `resolveDetectors(policy.scanner.enabled, policy.scanner.detectors)`. First hit → 403 `{error: "egress_blocked", detector: "<name>"}` + audit row `outcome: "egress_blocked"`, `reason: "<detector_name>"`. New `blockedEgress()` helper alongside `denied()`. |
| Scanner unit tests | `tests/scanner.test.ts` (new) | 28 tests: each detector positive + near-miss, short-circuit ordering, lastIndex hygiene, empty input, no-substring-leak (ScanHit shape), resolveDetectors all branches. |
| Integration tests | `tests/policy-proxy.test.ts` | +7 tests: default-on AWS block, no-substring-leak assertion across response body + audit row, no-quota-consumed, benign body passes, `enabled:false` opt-out, narrowed `detectors` allow-list, ordering vs provider_forbidden. |
| Policy test fixture | `tests/policy.test.ts` | `emptyPolicy()` helper updated to include `scanner: { enabled: true }` (type-level only — no behavior change). |
| Docs | `README.md` "What's enforced per token" | New row for Egress scanner; updated Fleet policy row to mention `scanner` key. |

**Tests:** 430 pass / 17 files (was 395 → +35 across Phase 3.6).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **`egress_blocked` is a new `outcome` value, not a new `reason`
   under `"denied"`.** Distinguishing the two means FinOps/SRE
   queries partition cleanly: `WHERE outcome = 'egress_blocked'`
   shows leaks the broker caught, regardless of which detector
   fired. The existing `denied` outcomes already crowd the `reason`
   field with policy/scope/cap/model variants — burying the headline
   wedge in there would be a UX loss.
2. **Scanner is default-on, all built-ins active.** The plan's
   strategic positioning frames egress-blocked as the headline
   differentiator. Off-by-default would undermine that. Operators
   who don't want the scanner set `"scanner": {"enabled": false}`
   explicitly. Test fixtures using benign bodies pass through
   unchanged; the 5 patterns are precise enough that random text
   doesn't match.
3. **Detector name only in audit row and 403 response. The matched
   substring is NEVER logged or emitted.** This is the load-bearing
   privacy invariant. `ScanHit` type has exactly one field
   (`detector: string`); the runtime test in `scanner.test.ts`
   asserts `Object.keys(hit).length === 1` so a future contributor
   adding a `match` field for "debugging" trips the test. The
   integration test additionally greps response body + audit row
   JSON for the secret and asserts absence.
4. **Scanner runs AFTER `provider_forbidden`, BEFORE the model gate.**
   - After provider_forbidden: a misrouted request gets denied
     before any egress would happen; scanning would only add noise.
   - Before the model gate: a leak in the body blocks even when
     the model is allowed. The scanner is about *the bytes*, not
     the model.
5. **First-hit short-circuits.** Pattern ordering in
   `BUILTIN_DETECTORS` is fixed and tested. The 5 patterns are
   independent enough that order rarely matters in practice; the
   "AWS wins over GitHub PAT when both present" test pins it just
   so a refactor that reorders can't quietly change audit-row
   detector attribution.
6. **Fail-OPEN twice: missing policy file → scanner on, malformed
   `scanner` key → scanner on with default config.** This is the
   opposite of policy.json's overall fail-open (missing file = no
   enforcement), and intentional. A typo in `policy.json` must not
   silently disable the headline differentiator. The trade-off is
   that operators who *want* the scanner off have to set
   `"enabled": false` correctly; misspelling that key (e.g.
   `"enable": false`) leaves the scanner on. That's the right
   posture — fail-closed for the egress block, fail-open for the
   permissive paths.
7. **No new SQLite migration.** The `outcome` column is `TEXT NOT
   NULL`; it already accepts any string. Adding `"egress_blocked"`
   to the TypeScript union is the only enforcement layer needed.
   This contradicts the plan's "audit schema migration #2" line —
   the plan was conservative; the actual schema didn't need a
   change.
8. **No CLI changes.** Policy is edited as JSON; the scanner
   surfaces in audit logs (queryable via `keybroker logs`) and in
   the prototype's "Recent Activity" card. A future `keybroker
   scanner test '<text>'` subcommand for local triage would be
   nice; not load-bearing for the shipping wedge.
9. **Layer 1 only (regex). No verification API calls, no entropy
   layer, no PII detection.** This matches the plan's Phase 3.6
   scope. Layer 2 (TruffleHog binary integration) and Layer 3
   (Presidio / SLM PII) are explicitly Phase 4.2. The deep-research
   prompt at `Claude-Deep-Research-Prompt.md` (untracked, separate
   document) is meant to inform 4.2's architecture choices —
   especially whether Layer 2's verification economics pay off on
   a single-laptop deployment.

---

## Files of note

| File | What |
|---|---|
| `src/scanner.ts:BUILTIN_DETECTORS` | The 5 patterns. Adding a sixth: add an entry here (regex with `/g` flag, stable `name`, short `description`), then add positive + near-miss tests in `tests/scanner.test.ts`. No other file changes needed — `resolveDetectors` picks them up by name. |
| `src/server.ts:blockedEgress` | The audit + 403 helper. Mirror of `denied()` with outcome="egress_blocked". |
| `src/policy.ts:scannerConfigFromRaw` | The fail-OPEN-OPEN behavior. If you ever need fail-CLOSED on scanner misconfig, this is the single point of change. |
| `tests/policy-proxy.test.ts` "policy: scanner (Phase 3.6)" | End-to-end coverage — assertion-by-assertion the invariants above. |
| `Prototype.html` | Has a "secret leak detection" card the FE team can now wire to real audit data: filter `outcome = "egress_blocked"`, group by `reason` (= detector name). |

---

## What to do next

Three reasonable next moves; user picks.

### Option A — Phase 3.7 (TTFT/TPOT latency telemetry)

The other prerequisite for Phase 4.0 (real frontend). Plan calls it
out as Claude-fit because "streaming response handling in Fastify is
fiddly". Adds `ttft_ms`, `tpot_ms_avg`, `output_tokens` to the audit
schema (SQLite migration #2, this time really needed). Touches the
proxy's response pipe — the `Transform`-stream-byte-counter that
already powers `respBytes` accounting is the obvious extension point.

### Option B — Phase 3.8 (rotate-all + batch reissue)

Smaller, well-shaped CLI work. Plan flags it as "Kimi-fit" — adds
`token rotate-all`, `token reissue-batch`, `token rotate-all --preview`.
Backs the prototype's fire-drill UX with real ops. Doesn't touch the
proxy hot path.

### Option C — Phase 4.2 prep (deep-research on scanner Layer 2/3)

The deep-research prompt is already drafted (`Claude-Deep-Research-Prompt.md`).
Hand it to a research instance, wait for the deliverable, then make
the Layer-2/3 architecture call. This is a *blocking* step for 4.2,
not implementation work — better done as a parallel research spawn
than a synchronous claim on the next session.

**Recommend A** — Phase 3.7. With 3.6 done, latency split is the
remaining piece before the prototype-to-real wire-up in Phase 4.0
becomes worthwhile. The proxy hot path already has the streaming
transform; we're extending its instrumentation, not introducing it.

---

## Phase 3.6 smoke test the next instance can run

(Optional — unit + integration coverage is comprehensive, but a
manual smoke against a real upstream confirms the operator UX.)

```sh
# Default-on scanner blocks a leak:
keybroker token issue --provider openai --scope '*' \
  --max-calls 5 --label smoke-leak
# Use the brk_ token:
curl -X POST http://127.0.0.1:7843/openai/v1/chat/completions \
  -H "Authorization: Bearer $BRK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"key is AKIAIOSFODNN7EXAMPLE"}]}'
# Expected: HTTP 403, body {"error":"egress_blocked","detector":"aws_access_key"}
# Expected: keybroker logs --since 1m shows outcome=egress_blocked, reason=aws_access_key.

# Then opt out via policy and re-run — same body should now pass to upstream:
echo '{"scanner":{"enabled":false}}' > ~/.keybroker/policy.json
# Re-issue token (or reuse if quota left), re-run curl, expect upstream response.
```

---

## Stop-and-check-in triggers (carry forward)

- Before changing `ExtractorInput` again — touches every provider's
  extractor.
- Before adding any auto-kill behavior to the broker sidecar.
  Spawn-and-leave is deliberate.
- Before shipping the `policy.json` `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before
  any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in dispatcher's `keybroker.mjs`
  assumes the dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` —
  `Date.parse` is permissive enough to be a footgun; add deliberately
  and validate strictly.
- **Phase 3.6 (active):** before logging the matched secret substring
  ANYWHERE — the policy default is detector-name-only, and the
  invariant is asserted in tests. If you find yourself wanting the
  matched bytes for a "better debug message", DON'T. Add a separate
  ops-only counter keyed by detector name instead.
- **Phase 3.6 (active):** before adding a sixth built-in detector,
  ask whether it has a fixed prefix or shape. Generic-entropy /
  arbitrary-base64 patterns belong in Layer 3, not Layer 1 — they
  produce false positives in normal prompt content.
- **Phase 3.6 (active):** before flipping `scanner.enabled` to
  default-off, reread decision 2 and 6 above. The default-on posture
  is load-bearing for the wedge story.
- **Phase 3.2.5:** before adding a third `authStyle` literal, ask
  whether `"header"` + a different `authHeader` covers it.
- **Phase 3.2 commit 4:** before flipping `KEYBROKER_ROUTE` to
  default-on, smoke-test against real upstreams.

---

## Useful commands

```sh
# from keybroker
npx vitest run                                # 430 tests, ~20s
npx vitest run tests/scanner.test.ts          # 28 unit tests
npx vitest run tests/policy-proxy.test.ts     # 20 integration tests (7 scanner)
npm run typecheck                             # clean

# Inspect what was scanned:
keybroker logs --outcome egress_blocked       # (NB: --outcome filter
                                              #  not yet implemented; today
                                              #  pipe through jq instead)
```

---

## Final state

- One commit on `main`: scanner module + outcome enum + policy + server
  hook + tests + README. Push pending user authorization.
- 430 tests pass, typecheck clean.
- Phase 3.6 exit criteria met: test injects an AWS key into a prompt
  → request blocked → audit log shows `egress_blocked` with detector
  name. Existing flows unaffected. Scanner can be disabled per policy.
- Plan file `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  Phase 3.6 scope shipped. Next phase per plan ordering: 3.7 (TTFT/TPOT).

Take your time.
