# Handoff — keybroker Phase 3.3 complete (2026-05-10)

You are the next instance. Phase 3.3 (token tags) shipped in three
commits. Phase 3.2 is still partial — see the prior handoff
`HANDOFF-2026-05-10-phase-3-2-progress.md` for what's left there.

---

## What landed

| Commit | Hash | Layer |
|---|---|---|
| 3.3/1 — claim + policy + sign/verify | `9b5061e` | tokens.ts, policy.ts, tests |
| 3.3/2 — storage: TokenRecord + audit columns | `2fa7ce8` | store-types, store-sqlite, logging, tests |
| 3.3/3 — CLI flags, server propagation, list display | `66b5a1c` | cli.ts, server.ts, README, tests |

All three committed locally, **NOT yet pushed** to origin/main as of
this handoff. (Phase 3.2's commit `db4da09` and its predecessors are
already on origin.)

**Tests:** 296 pass / 14 files. 22 new tests for Phase 3.3:
- 13 in `tests/tokens.test.ts` (round-trip, malformed, length cap, forward-compat)
- 6 in `tests/policy.test.ts` (load `tag_allowlist`, per-key denial)
- 9 in `tests/store.test.ts` (round-trip both stores + idempotent migration)
- 4 in `tests/proxy.test.ts` (end-to-end audit propagation: ok / partial / denied / untagged)

`npm run typecheck` is clean.

---

## Decisions locked in (don't re-litigate)

1. **Policy shape:** hybrid per-tag allow-list. `tag_allowlist.<key>`
   missing or `[]` = no restriction. Configured key must match.
   Unknown tag keys (e.g. `region`) are silently ignored — the
   schema is not extensible from the policy side without a code
   change.
2. **JWT claim shape:** single `tag: { t?, p?, e? }` object. Not three
   flat claims. Smaller JWT, single nullability check. Vacuous `{}`
   is malformed.
3. **MAX_TAG_VALUE_LEN = 64.** Exported from `tokens.ts`. Both issue
   and verify enforce it.
4. **Server trusts the signed claim.** No re-validation against
   policy on the request path. Same posture as `mch`/`cap`. The CLI
   is the one and only allow-list checkpoint.
5. **Tag attribution is captured once** after verify into
   `auditAttribution = { machine, claims }` and spread into every
   `denied()` ctx. A new `applyTagAttribution(entry, claims)` helper
   handles success / error paths. This was a small refactor of 16
   call sites — the diff is mechanical, not semantic.

---

## Files of note (in addition to the prior handoff)

| File | Change |
|---|---|
| `src/tokens.ts` | `BrokerTagClaim` interface, `MAX_TAG_VALUE_LEN`, `tag` claim on `BrokerClaims`, `tags` arg on `issueToken`, validation in `verifyToken`. |
| `src/policy.ts` | `TagAllowlist`, `TagKey`, `tagAllowlist` field on `Policy`, `policyDeniesTag(p, key, value)`, `tag_allowlist` JSON parse. |
| `src/store-types.ts` | `TokenRecord.tagTeam/tagProject/tagEnv`. |
| `src/logging.ts` | `CallLogEntry.tagTeam/tagProject/tagEnv`. |
| `src/store-sqlite.ts` | `tag_team/tag_project/tag_env` columns on tokens + calls (CREATE TABLE + idempotent ALTER), threaded through every prepared statement. |
| `src/cli.ts` | `--team/--project/--env` flags on `token issue`, policy validation before signing, tag display on `token list`. |
| `src/server.ts` | `auditAttribution` spread refactor + `applyTagAttribution` helper. Every audit-write path now carries the signed tag. |
| `README.md` | "what's enforced" gets a Tags row; architecture sketch mentions tag fields. |

---

## What to do next

Two reasonable next moves; user picks:

### Option A — Phase 3.4 (tag-based aggregation + dashboard endpoints)

This is the natural follow-on. Now that tag attribution is in the
audit log, the next phase wires the queries. Plan section "Phase
3.4" is short:

1. New store methods `sumCostUsdByTagSince(tag, ts)` and
   `topTagsBySpend(tag, since, limit)`.
2. New route `GET /metrics/spend?bucket=team&since=24h`.
3. CLI: `keybroker metrics spend --by team --since 24h`.

The plan flags this as **Kimi/Codestral delegation territory** —
narrow SQL + endpoint work, no architecture decisions. Good
candidate for a free-tier handoff if budget pressure is high.

### Option B — Phase 3.2.5 (gemini + mistral providers)

Unblocks Phase 3.2 commit 4 (replace `Bearer ${apiKey}` with
`Bearer ${brokerToken}` in dispatcher's `provider.mjs`). The
prior handoff documents this — the gnarly bit is Gemini's
path-based model parameter forcing a `ProviderSpec`
extractRequestMetadata signature change that ripples into Phase
3.6. Plan flags this as worth a fresh planning pass first.

Recommend A unless you specifically want the dispatcher
integration's telemetry to start landing. A leaves Phase 3.2.5
for a session where you can do the planning pass cleanly.

---

## Stop-and-check-in triggers (carry forward)

- Before changing the `ProviderSpec.extractRequestMetadata`
  signature in Phase 3.2.5 — ripples into Phase 3.6.
- Before adding any auto-kill behavior to the broker sidecar.
  Spawn-and-leave is deliberate.
- Before shipping the policy.json `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before
  any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in dispatcher's
  `keybroker.mjs` assumes the dev path.

---

## Useful commands

```sh
# from keybroker
git push origin main                     # if these 3 commits are still local
npx vitest run                           # 296 tests, ~17s
npm run typecheck                        # clean

# manual smoke
keybroker token issue --provider echo \
  --team platform --project dispatcher --env prod \
  --label "phase-3-3-smoke"
keybroker tokens                         # should show team=... project=... env=...
```

---

## Final state

- 3 commits on local `main`, not yet pushed.
- All tests green, typecheck clean.
- Phase 3.3 spec exit criteria met: schema + policy + CLI all wired,
  README updated, audit row carries tag attribution end-to-end.
- Plan file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  is unchanged — Phase 3.3 spec there matches what shipped.

Take your time.
