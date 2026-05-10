# Handoff — keybroker Phase 3.4 complete (2026-05-10)

You are the next instance. Phase 3.4 (tag-based aggregation + dashboard
endpoint) is implemented but **not yet committed** as of this handoff
— the working tree has the changes, ready for review and a clean
commit by the next instance (or split into 2-3 commits if you prefer).

Phase 3.2 commit 4 is still blocked on Phase 3.2.5 — unchanged from
the prior handoff (`HANDOFF-2026-05-10-phase-3-3.md`).

---

## What's in the working tree

| Layer | File | Change |
|---|---|---|
| Contract | `src/store-types.ts` | `TagBucket` type, `TagSpendRow`, `sumCostUsdByTagSince(bucket, ts)`, `topTagsBySpend(bucket, since, limit)` on `StoreLike`. |
| SQLite | `src/store-sqlite.ts` | 6 new prepared statements (sum + top × team/project/env), partial indexes `calls_tag_<bucket>_ts_idx WHERE tag_X IS NOT NULL`. |
| JSON | `src/store-json.ts` | Same two methods, JSONL scan. Sort matches SQLite's `ORDER BY usd DESC, key ASC`. |
| Barrel | `src/store.ts` | Re-export `TagBucket`, `TagSpendRow`. |
| Server | `src/server.ts` | `GET /metrics/spend?bucket=team\|project\|env&since=24h&limit=50`. Exports `parseSinceShorthand`. |
| CLI | `src/cli.ts` | `keybroker metrics spend --by team --since 24h [--limit n] [--json]` — store-direct (no broker required). |
| Tests | `tests/store.test.ts` | 13 new tests across both stores (Phase 3.4 block). |
| Tests | `tests/proxy.test.ts` | 9 new tests for `/metrics/spend`. |
| Docs | `README.md` | "what's enforced" gains a Spend rollups row; "what is already solid" lists Phase 3.3 + 3.4. |

**Tests:** 331 pass / 14 files (was 296 → +35 across Phase 3.4).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **Untagged calls are excluded from tag aggregations.** Both the
   `Record<string, number>` shape (`sumCostUsdByTagSince`) and the
   ranked array (`topTagsBySpend`) filter `tag_X IS NOT NULL`. Tag
   aggregation is opt-in; an untagged "" bucket would dominate any
   project that hasn't fully rolled out tagging. For total spend,
   callers use `sumCostUsdSince`. This is the deliberate divergence
   from `sumCostUsdByMachineSince` (which DOES bucket untagged under
   `""` because every token gets a machine).
2. **Denied calls are excluded** — same posture as `sumCostUsdSince`.
   Denied requests never reached upstream and have no spend; counting
   them in the bucket would mislead the dashboard.
3. **Order is `usd DESC, key ASC`.** The alphabetic tiebreak is
   load-bearing — without it, two buckets with identical spend would
   come back in undefined order, which would flake snapshot tests and
   cause UI diff-render churn. The JSON store sort mirrors this so
   the two backends are interchangeable.
4. **`since=` shorthand only.** `30s|10m|24h|7d`. We deliberately
   reject ISO timestamps because `Date.parse` is permissive enough
   that an attacker-controlled string can produce surprising windows.
   The shorthand is the operator-facing UX both the dashboard cards
   and the CLI use. ISO support can be added later if a use case
   emerges. Capped at ~10 years so a typo can't pull the whole table.
5. **Three pairs of prepared statements, not one with dynamic SQL.**
   `bucket` is reachable from the HTTP layer (`?bucket=...`); building
   a SQL fragment from request input is exactly the kind of thing
   that turns into table drops. The closed `TagBucket` type +
   `tagSumStmt` / `tagTopStmt` switch are the safety boundary.
6. **CLI is store-direct, not HTTP.** `keybroker metrics spend` opens
   the store and calls `topTagsBySpend` itself. Same pattern as
   `keybroker logs`. Means the broker doesn't need to be running to
   query spend, which matches the "personal-fleet" working assumption.
7. **`/metrics/spend` is unauthenticated.** Same posture as `/health`
   — broker binds 127.0.0.1 by default, intended for the operator's
   own dashboard / CLI. Revisit when external exposure happens
   (Phase 4).
8. **Default limit = 50, max = 1000.** A team rollup with hundreds of
   teams is unusual; 50 is enough for a dashboard card, 1000 is
   enough for a "show everything" CLI dump. Limit must be an integer.
9. **Partial indexes on `(ts, tag_X) WHERE tag_X IS NOT NULL`.** Most
   calls in early rollout will be untagged; a partial index stays
   small and matches the access pattern of "time window + bucket".

---

## Files of note (in addition to the prior handoff)

| File | What |
|---|---|
| `src/store-types.ts` | `TagBucket = "team"\|"project"\|"env"`, `TagSpendRow = { key, usd, callCount }`, two new methods on `StoreLike` with rationale comments. |
| `src/store-sqlite.ts:284-326` | The 6 new prepared statements. Ordered by `usd DESC, key ASC`. |
| `src/store-sqlite.ts:469-477` | Partial indexes for the tag buckets. |
| `src/store-sqlite.ts:tagSumStmt/tagTopStmt` | The `bucket → statement` dispatcher. |
| `src/store-json.ts` | Mirror implementation; sort + slice in TS so the two stores match in tests. |
| `src/server.ts:43-86` | `/metrics/spend` route handler. Returns 400 on `invalid_bucket`, `missing_since`, `invalid_since`, `invalid_limit`. |
| `src/server.ts:parseSinceShorthand` | Exported so the CLI shares the parser without duplicating regex / unit math. |
| `src/cli.ts:metrics spend` | CLI subcommand. `--by`, `--since`, `--limit`, `--json` flags. Right-aligned table when not `--json`. |

---

## What to do next

Two reasonable next moves; user picks:

### Option A — Phase 3.5 (linear regression burn forecast)

Builds directly on 3.4's aggregation primitives. Plan section "Phase
3.5":

1. New `src/forecast.ts` — Least Squares per research doc §3.2.
   Input: array of `{day, cumUsd}`. Output:
   `{ slopeUsdPerDay, interceptUsd, daysUntilCap, projectedCapBreachDate }`.
2. New routes: `GET /forecast/tokens` (risk-ranked) +
   `GET /forecast/tags?bucket=team`.
3. CLI: `keybroker forecast --top 10`.
4. Verify against a hand-computed 14-day reference series.

The plan flags this as **Kimi/Codestral delegation territory** — pure
math + SQL, deterministic tests. Same delegation latitude as 3.4.

### Option B — Phase 3.2.5 (gemini + mistral providers)

Unblocks Phase 3.2 commit 4 (replace `Bearer ${apiKey}` with
`Bearer ${brokerToken}` in dispatcher's `provider.mjs`). Gnarly bit:
Gemini's path-based model parameter forces a `ProviderSpec.extractRequestMetadata`
signature change that ripples into Phase 3.6. Plan flags as worth a
fresh planning pass first.

Recommend A unless you want dispatcher integration's telemetry
landing now. Each phase you add to the audit log makes the dispatcher
integration's payoff bigger when 3.2.5 finally lands.

---

## Stop-and-check-in triggers (carry forward)

- Before changing the `ProviderSpec.extractRequestMetadata` signature
  in Phase 3.2.5 — ripples into Phase 3.6.
- Before adding any auto-kill behavior to the broker sidecar.
  Spawn-and-leave is deliberate.
- Before shipping the policy.json `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before
  any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in dispatcher's `keybroker.mjs`
  assumes the dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` —
  `Date.parse` is permissive enough to be a footgun; add deliberately
  and validate strictly.

---

## Useful commands

```sh
# from keybroker
git status                                 # see the Phase 3.4 changes
git diff --stat                            # 9 files, ~691 insertions
npx vitest run                             # 331 tests, ~18s
npm run typecheck                          # clean

# manual smoke (requires `keybroker init` first)
keybroker token issue --provider echo \
  --team platform --project dispatcher --env prod \
  --label "phase-3-4-smoke"

# emit some calls so there's data to aggregate, then:
keybroker metrics spend --by team    --since 24h
keybroker metrics spend --by project --since 7d --limit 10
keybroker metrics spend --by env     --since 1h --json

# HTTP equivalents (broker on default 127.0.0.1:7843):
curl 'http://127.0.0.1:7843/metrics/spend?bucket=team&since=24h'
curl 'http://127.0.0.1:7843/metrics/spend?bucket=project&since=7d&limit=10'
```

---

## Suggested commit shape (if you want to split)

If you'd rather split this into separate commits before pushing,
natural seams:

1. **3.4/1 — store contract + implementations.** `src/store-types.ts`,
   `src/store-sqlite.ts`, `src/store-json.ts`, `src/store.ts`,
   `tests/store.test.ts` (Phase 3.4 block only).
2. **3.4/2 — `/metrics/spend` route + CLI.** `src/server.ts`,
   `src/cli.ts`, `tests/proxy.test.ts` (Phase 3.4 block).
3. **3.4/3 — README.** Just `README.md`.

A single commit is also fine — the changes are coherent and test
coverage gates them together.

---

## Final state

- Working tree: 9 files modified, 0 untracked, 0 staged. Phase 3.4
  changes ready to commit.
- Phase 3.4 spec exit criteria met: dashboard rollup cards can be
  wired to real data with a single fetch swap; CLI surface ships.
- All tests green, typecheck clean.
- Plan file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  unchanged — Phase 3.4 spec there matches what shipped.

Take your time.
