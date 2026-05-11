# Handoff — keybroker Phase 3.8 complete (2026-05-10)

You are the next instance. Phase 3.8 — `rotate-all` + `reissue-batch`,
the fire-drill ops backend the prototype's rotation UX has been
miming — shipped as a single commit on this turn. Working tree should
be clean after the commit. Phase 3.7 (latency telemetry) shipped
earlier today; see `HANDOFF-2026-05-10-phase-3-7.md`.

The 3.x roadmap is now done. Phase 4.0 (real frontend) is the natural
next move.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Pure rotation module | `src/rotate.ts` (new) | `applyRotationFilters`, `buildReissueArgs`, `tokenClaimSummary`, `computeRotationPreview`. Pure functions — no I/O, no globals. Designed for unit testing without spawning the CLI. |
| Token schema | `src/store-types.ts` | `TokenRecord.models?: string[]` added. Same posture as `capUsd` / tag fields: stored at issue time, NEVER read for enforcement (the JWT `mdl` claim remains the source of truth). Exists so rotate-all can preserve the model restriction across rotation. |
| SQLite migration | `src/store-sqlite.ts` | Idempotent `ALTER TABLE tokens ADD COLUMN models TEXT` (JSON-encoded string array). `putToken` / `getToken` / `listTokens*` projections all updated to round-trip the column. JSON corruption is silently dropped from `rowToToken` (matches the malformed-line posture of the JSON store aggregators). |
| CLI: `rotate-all` | `src/cli.ts` | `keybroker token rotate-all [--team T] [--project P] [--env E] [--machine M] [--provider P] [--preview] [--dry-run] [--yes]`. Filter-AND. **At least one filter required** — refusing full-fleet rotation in a single command is a deliberate guardrail. `--preview` prints counts only (by machine, by tag); `--dry-run` prints the full plan; default revokes + reissues with identical claims. `--yes` skips the interactive confirmation. |
| CLI: `reissue-batch` | `src/cli.ts` | `keybroker token reissue-batch --since <shorthand> [--from-revoked] [tag filters] [--dry-run] [--yes]`. Picks revoked tokens whose `createdAt` ≥ `now - since` and reissues them with identical claims. `--from-revoked` is a no-op marker for explicit intent (reissue-batch *always* draws from revoked tokens). |
| CLI: issue path | `src/cli.ts` | When `--model` is provided, the `models` field is now persisted on TokenRecord (Phase 3.8 — rotate parity). |
| Tests: pure unit | `tests/rotate.test.ts` (new, 17 tests) | `applyRotationFilters` (single, AND, untagged-excluded), `buildReissueArgs` (preserve every field, TTL never extends, expired returns undefined, empty-models vs undefined-models distinction), `computeRotationPreview` (per-bucket counts), `tokenClaimSummary` (full + minimal). |
| Tests: CLI integration | `tests/rotate-cli.test.ts` (new, 3 tests) | preview → dry-run → real run agree on count; reissue-batch picks up revoked token within `--since 1h` and reissues with parity (cap + machine preserved); `--model` on post-3.8 issue carries through rotation without lossy warning. Spawn-based, each scenario bundled into one it-block to keep tsx invocations bounded. |
| Docs | `README.md` | Revocation row updated to mention `rotate-all` and `reissue-batch`. |

**Tests:** 461 pass / 20 files (was 441 → +20 across Phase 3.8).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **`rotate-all` requires at least one filter.** No-filter rotation
   is intentionally not a single command. The fire-drill cases
   (team offboard, project deprecation, machine compromise) all
   pass a filter; the rare "rotate everything" case can be done
   per-filter, or by combining `revoke-all --machine` per machine.
   Cutting every token in one keystroke is exactly the kind of thing
   that gets done by accident.
2. **TTL is preserved as remaining seconds, never extended.**
   `buildReissueArgs` computes `expiresAt - now`. Rotating a token
   that has 10 minutes left issues a token with 10 minutes of life.
   Operators who want a fresh lifetime should issue a new token; the
   rotation primitive's contract is "same claims, fresh secret."
3. **Already-expired tokens are silently skipped, separately
   reported.** A token with `expiresAt < now` returns `undefined` from
   `buildReissueArgs` and lands in the "skipped" bucket. The dead
   token already enforces nothing; reissuing a dead-on-arrival
   replacement is noise.
4. **Revoke FIRST, then reissue.** Loop order in `rotateAll` is
   revoke-each → reissue-each. If the process is killed mid-loop,
   the fleet ends up in "old keys are dead" state, not "old + new
   keys both valid" state. Safer default.
5. **`models` is persisted but the JWT remains the source of truth
   for enforcement.** The Phase 2.1 deny-by-default for missing
   model still applies; the column is *display + rotation parity*
   only. A future attacker who tampered with the column directly
   could only loosen rotation behavior, not enforcement.
6. **Pre-3.8 records with model restrictions: lose the restriction
   on rotation, warn loudly.** We can't tell whether a record without
   a persisted `models` column was issued unrestricted or with a
   restriction we didn't store. The warning lists the count and
   advises manual reissue. Going forward (post-3.8 issues), the
   column rides the record and rotation is lossless.
7. **`reissue-batch` window is keyed on `createdAt`, not a
   non-existent `revoked_at`.** The audit log records revocations
   ambiently (as `denied` rows with reason `revoked`), but the
   tokens table has no per-row revoke timestamp. For the common
   case ("laptop stolen yesterday, rotated this morning, reissue
   today"), `createdAt within --since` is the correct selector.
   If a future operator needs revoke-time selection, add
   `revoked_at` to the tokens schema — it's a cheap migration.
8. **`--from-revoked` flag is a marker, semantically a no-op.**
   `reissue-batch` always pulls from revoked tokens. The flag exists
   because the plan named it; keeping it makes the command's intent
   self-documenting at call sites (`reissue-batch --from-revoked
   --since 24h` reads cleanly).
9. **Output: revoke/source-id pairs on stderr, new JWTs on stdout.**
   The operator can pipe stdout to a secret manager (`./rotate-all
   ... | secret-manager-import`) without machine-parsing the
   bookkeeping. Each reissue block is separated by a blank line so
   diff/grep stay clean.
10. **Empty `models: []` vs missing `models: undefined`.** Treated
    differently. Empty array means "operator explicitly cleared the
    restriction" (no warning). Undefined means "pre-3.8 record, we
    don't know" (warning). The distinction surfaces in the
    `noModelsClaim` field on the plan item.

---

## Files of note

| File | What |
|---|---|
| `src/rotate.ts` | The whole rotation primitive — pure functions, no I/O. If a future bucket (e.g. `--label`) is added, extend `RotationFilters` + `applyRotationFilters` here. |
| `src/cli.ts:rotateAll` / `:reissueBatch` | The CLI handlers — stitch loadConfig, openStore, the pure helpers, and confirm prompts. Each follows the same plan-then-act shape (build plan → print plan → confirm → execute). |
| `src/store-sqlite.ts:rowToToken` | The point where the SQLite `models` column is parsed back into the TokenRecord. JSON corruption is dropped silently. |
| `tests/rotate.test.ts` | Pure unit tests — no spawning, fast (<1s). Reference shape for testing future rotation features. |
| `tests/rotate-cli.test.ts` | End-to-end CLI integration — each it-block batches multiple operations to keep `tsx` spawn count down. |

---

## What to do next

Three reasonable next moves; user picks.

### Option A — Phase 4.0 (real frontend)

The 3.x roadmap is done; latency telemetry + rotation ops are
the two prerequisites listed in the plan for retiring
`Prototype.html`. Vite + React 18, route per screen, Recharts
for the waterfall/forecasts the Phase 3.5/3.7 endpoints feed.
Mid-size effort, but the wedge of "real cap dashboard, real
rotation UX, real leak detector" lands in one shippable package.

### Option B — Phase 4.1 (TUI variant)

Smaller. Ink + Yoga. Status bar with current spend, active
tokens, current machine. Doc says "essential, not optional" but
the value is biggest once the underlying telemetry lands; with
3.7 done, 4.1 is now well-supported.

### Option C — Phase 4.2 prep (deep-research on scanner Layer 2/3)

The deep-research prompt is already drafted
(`Claude-Deep-Research-Prompt.md`). Hand it to a research
instance; the deliverable informs Layer-2 (TruffleHog) and
Layer-3 (Presidio / SLM PII) architecture choices. *Blocking
step* for 4.2, not implementation.

**Recommend A** — Phase 4.0. With 3.6/3.7/3.8 shipped, the wedge
story is complete on the backend; turning the prototype into a
shippable app is the natural next move and the highest-leverage
visible change since the roadmap began.

---

## Phase 3.8 smoke test the next instance can run

(Optional — unit + integration coverage is comprehensive, but a
manual smoke against a real upstream confirms the operator UX.)

```sh
# 1. Issue a few tagged tokens.
keybroker token issue --provider openai --team platform --project ci --label tok-a
keybroker token issue --provider openai --team platform --label tok-b
keybroker token issue --provider openai --team data --label tok-c

# 2. Blast-radius preview before rotating.
keybroker token rotate-all --team platform --preview
# Expected: active matched: 2, by machine, by team: platform: 2.

# 3. Plan check.
keybroker token rotate-all --team platform --dry-run --yes
# Expected: "rotate plan: 2 reissue(s), 0 skipped" on stderr;
# "(dry-run — no changes written)" on stdout; tokens still active.

# 4. Real run.
keybroker token rotate-all --team platform --yes
# Expected: two new JWTs on stdout, "done — 2/2 revoked, 2/2 reissued"
# on stderr; `keybroker token list` shows old (REVOKED) + new (active)
# pairs for tok-a/tok-b; tok-c unaffected.

# 5. Revoke-then-reissue-batch round trip.
keybroker token issue --provider openai --machine $(hostname) --label fire-drill
keybroker token revoke-all --machine $(hostname) --yes
keybroker token reissue-batch --since 1h --from-revoked --machine $(hostname) --yes
# Expected: new JWT printed; `keybroker token list` shows the revoked
# source + new active replacement.
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
- Before logging the matched secret substring ANYWHERE — the policy
  default is detector-name-only, and the invariant is asserted in
  tests. If you find yourself wanting the matched bytes for a "better
  debug message", DON'T. Add a separate ops-only counter keyed by
  detector name instead.
- Before adding a sixth built-in detector, ask whether it has a fixed
  prefix or shape. Generic-entropy / arbitrary-base64 patterns belong
  in Layer 3, not Layer 1 — they produce false positives in normal
  prompt content.
- Before flipping `scanner.enabled` to default-off, reread the Phase
  3.6 decision log. The default-on posture is load-bearing for the
  wedge story.
- Before adding a third `authStyle` literal, ask whether `"header"` +
  a different `authHeader` covers it.
- Before flipping `KEYBROKER_ROUTE` to default-on, smoke-test against
  real upstreams.
- Before adding per-chunk inter-arrival timings to the audit row, see
  Phase 3.7 decision 2. Per-chunk samples would blow the schema; if a
  chunk histogram is needed, add a separate retention-limited buffer.
- **Phase 3.8 (active):** before allowing a no-filter `rotate-all`,
  reread decision 1. Full-fleet rotation in a single keystroke is a
  footgun.
- **Phase 3.8 (active):** before letting `rotate-all` extend a
  token's lifetime (reading `--ttl` as input, etc.), reread decision
  2. Rotation preserves the existing TTL; lifetime extension is a
  separate operation by design.
- **Phase 3.8 (active):** before silently dropping the lossy-models
  warning, reread decision 6. The warning is the only signal an
  operator has that a pre-3.8 record may have lost its model
  restriction; suppressing it is a security regression.

---

## Useful commands

```sh
# from keybroker
npx vitest run                                # 461 tests, ~46s
npx vitest run tests/rotate.test.ts           # 17 unit tests, ~1s
npx vitest run tests/rotate-cli.test.ts       # 3 CLI integration, ~35s
npm run typecheck                             # clean

# Try the new commands.
keybroker token rotate-all --team platform --preview
keybroker token rotate-all --team platform --dry-run --yes
keybroker token reissue-batch --since 24h --from-revoked --machine alpha --yes
```

---

## Final state

- One commit on `main`: rotate.ts module + tokens schema migration +
  CLI commands + 17 unit + 3 integration tests + README.
  Push pending user authorization.
- 461 tests pass, typecheck clean.
- Phase 3.8 exit criteria met: dry-run preview matches real run's
  affected count (assertion in `tests/rotate-cli.test.ts`).
  Reissue-batch produces tokens with identical claims to the
  revoked set (cap + machine + model parity asserted; iat/jti are
  the only divergent fields).
- Plan file `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  Phase 3.8 scope shipped. **The 3.x roadmap is complete.** Next
  reasonable phase per plan ordering: 4.0 (real frontend), 4.1 (TUI),
  or 4.2 (Layer 2/3 scanning prep).

Take your time.
