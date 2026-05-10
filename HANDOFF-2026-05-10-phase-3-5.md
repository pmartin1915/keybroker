# Handoff — keybroker Phase 3.5 complete (2026-05-10)

You are the next instance. Phase 3.5 (linear-regression burn forecast)
landed as a single commit on top of `cddc33f`. Working tree is clean
once the commit is made (this handoff is the last file in the change).

Phase 3.2 commit 4 is still blocked on Phase 3.2.5 — unchanged from
the prior handoffs (`HANDOFF-2026-05-10-phase-3-3.md`, `HANDOFF-2026-
05-10-phase-3-4.md`).

---

## What landed

| Layer | File | Change |
|---|---|---|
| Pure math | `src/forecast.ts` (new) | `leastSquares`, `forecastBurn`, `buildDenseCumulativeSeries`, `utcDayOf`. No store / no I/O. |
| Contract | `src/store-types.ts` | `DailySpendRow`, `TagDailySpendRow`, `dailySpendByTokenSince`, `dailySpendByTagSince` on `StoreLike`. |
| SQLite | `src/store-sqlite.ts` | 4 new prepared statements + `tagDailyStmt` dispatcher. Row-level `cost IS NOT NULL` filter so the sparse output matches the JSON store. |
| JSON | `src/store-json.ts` | Mirror implementation; same sort posture as the SQL `ORDER BY day, key`. |
| Barrel | `src/store.ts` | Re-export `DailySpendRow`, `TagDailySpendRow`. |
| Server | `src/server.ts` | `GET /forecast/tokens`, `GET /forecast/tags`. Exports `forecastTokens`, `forecastTags`, `TokenForecastRow`, `TagForecastRow`. |
| CLI | `src/cli.ts` | `keybroker forecast [--by team\|project\|env] [--since 14d] [--top 10] [--json]` — store-direct (no broker required). |
| Tests | `tests/forecast.test.ts` (new) | 19 tests covering math, density, projection edges. Hand-computed reference (y = 2x + 3) verifies slope/intercept exactly. |
| Tests | `tests/store.test.ts` | 8 new tests across both stores (Phase 3.5 daily-cumulative block). |
| Tests | `tests/proxy.test.ts` | 8 new tests for the two `/forecast/*` routes. |
| Docs | `README.md` | "what's enforced" gains a Burn forecast row; "what is already solid" lists Phase 3.5. |

**Tests:** 375 pass / 15 files (was 331 → +44 across Phase 3.5).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **Dense cumulative regression, not sparse incremental.** Days with
   zero priced spend get a 0-increment cell so the cumulative line
   stays flat across them. This matches the FinOps story the dashboard
   tells ("burn rate over the window") and avoids the bias that sparse
   (day0, day5)-only fits would introduce. `buildDenseCumulativeSeries`
   is the contract.
2. **Sparse store output, dense forecast input.** `dailySpendByTokenSince`
   / `dailySpendByTagSince` return only days that had priced
   `ok`/`error` spend. Both backends must emit the *same* sparse set —
   the JSON store skips per-row when cost isn't finite, and the SQLite
   query has a row-level `COALESCE(actual, estimated) IS NOT NULL`
   filter so days with only unpriced rows don't leak through with
   `usd: 0`. Two-store equivalence is enforced in tests/store.test.ts.
3. **Window default = 14d.** `parseForecastSince` defaults to
   `now - 14d` when no `since` is supplied. The plan's reference
   series is 14 days; long enough to absorb day-of-week patterns,
   short enough to stay reactive. Operators can pass `--since 7d`
   for a tighter signal or `--since 30d` for monthly trending.
4. **Top default = 10, max = 1000.** Same posture as
   `/metrics/spend`'s `limit`. A dashboard card shows ~10; CLI dumps
   may need 1000.
5. **Slope ≤ 0 → no projection.** Idle and refunding tokens get
   `daysUntilCap` undefined rather than `Infinity` or a past date.
   The dashboard renders the missing field as "—" (no breach
   projected). Fail-readable, not fail-loud.
6. **Already-past-cap → daysUntilCap=0, breach=now.** A token whose
   audit log already exceeds its cap should surface as the most
   urgent row (sort key 0). The route does NOT 4xx; the breach has
   already happened, the dashboard needs to show it.
7. **Per-token sort: breach soonest first; no-projection rows last,
   alphabetic.** `compareForecastRows`. The label tiebreak makes the
   render stable across calls — same posture as `topTagsBySpend`'s
   `usd DESC, key ASC`.
8. **Per-tag sort: highest burn rate first, alphabetic tiebreak.**
   No cap means no `daysUntilCap`; slope is the meaningful axis.
9. **Routes are unauthenticated.** Same posture as `/health` and
   `/metrics/spend` — broker binds 127.0.0.1, intended for the
   operator's own dashboard / CLI. Revisit at Phase 4.
10. **CLI is store-direct, not HTTP.** `keybroker forecast` opens
    the store and calls `forecastTokens` / `forecastTags` itself.
    Same pattern as `keybroker logs` and `keybroker metrics spend`.
    Means the broker doesn't need to be running to query forecasts.
11. **`forecastTokens` / `forecastTags` are exported from
    `server.ts`.** They take `StoreLike` and are pure data transforms.
    The CLI imports them; the routes call them. If a future
    refactor wants to extract them into `src/forecast-server.ts`, the
    only callers are `src/server.ts` (routes) and `src/cli.ts` (CLI).
12. **UTC day boundaries (`YYYY-MM-DD` from `ts.slice(0, 10)` /
    `substr(ts, 1, 10)`).** Single source of truth. `utcDayOf(d)` is
    the only function that produces this format, used by both routes
    and CLI.

---

## Files of note (in addition to the prior handoff)

| File | What |
|---|---|
| `src/forecast.ts` | Pure module. `leastSquares` is closed-form OLS, returns `{0,0}` for empty, `{0, y₀}` for n=1, `{0, mean(y)}` when denominator is 0 (degenerate). `forecastBurn` projects `daysUntilCap` from slope and current cum spend; omits the field when slope ≤ 0 or no cap. |
| `src/store-sqlite.ts:dailySpendByTokenSince` | `substr(ts, 1, 10) AS day` extracts UTC date from the ISO string. Row-level cost-not-null filter is the load-bearing detail for two-store parity. |
| `src/store-json.ts:dailySpendByTagSince` | Two-level Map<day, Map<key, usd>> mirrors SQLite's `GROUP BY day, tag_X`. Sort is day asc then key asc. |
| `src/server.ts:forecastTokens` | Iterates all non-revoked tokens. Cheap for personal-fleet (≤ ~100 tokens); revisit when fleet scales. |
| `src/server.ts:forecastTags` | Groups sparse output by key, runs one regression per key. |
| `src/server.ts:parseForecastSince` | Defaults to 14d when missing. Otherwise delegates to `parseSinceShorthand` (no ISO timestamps — see Phase 3.4 decision). |
| `src/cli.ts:forecast` | Single command, optional `--by`. `printTable` helper handles right-alignment for $ amounts and days. |

---

## Hand-computed reference (the verification anchor)

The plan called for "verify against a hand-computed 14-day reference
series". `tests/forecast.test.ts` has two:

1. **Closed-form OLS recovery** — clean line `y = 2x + 3` for x ∈
   [0..4]. n=5, Σx=10, Σy=35, Σxy=90, Σx²=30. slope=100/50=2,
   intercept=15/5=3. Verified to 9 decimal places.
2. **Burn projection** — 14 days of $1/day cumulative spend, cap=$20.
   Slope=$1/day, current=$14, daysUntilCap=6, breach date 6 days from
   the test's fixed `NOW`. Verified `slope ∈ [0.9, 1.1]`, `current=14`,
   `daysUntilCap ∈ [5, 7]`, breach date prefix `2026-05-16`.

If a future change refactors the math, these two tests are the
load-bearing checks.

---

## What to do next

Two reasonable next moves; user picks.

### Option A — Phase 3.6 (inline secret scanning + egress_blocked)

The headline differentiator from the research doc. Plan section
"Phase 3.6":

1. Add `egress_blocked` to outcome enum (audit schema migration #2).
2. New `src/scanner.ts` — Layer 1 only (regex). AWS access keys,
   GitHub PATs, generic high-entropy strings, SSN, credit card.
3. Proxy hook: scan request body before forwarding. On hit, 403 with
   `{ reason: "egress_blocked", detector: "<name>" }`, audit.
4. `policy.json` adds `scanner` config.

The plan flags this as **Claude territory** — security-sensitive,
body parsing has the `body re-serialization` trap (see
`trap_body_reserialization.md` memory). Stop-and-check-in before
shipping the body-scan logic in production: do we log the matched
substring (debug) or only the detector name (safety)? Default
detector-only.

### Option B — Phase 3.2.5 (gemini + mistral providers)

Still blocking Phase 3.2 commit 4. Same rationale as the prior
handoff. Plan flags it as worth a fresh planning pass first because
Gemini's path-based model param ripples into Phase 3.6's scanner.

### Option C — Phase 3.7 (TTFT/TPOT latency telemetry)

Smaller scope than 3.6, but deferred until 3.6 because 3.6 unlocks the
prototype's headline screens (secret-leak detection). 3.7 would be
the third "telemetry phase" stacked on this same audit-log substrate.

**Recommend A** if you want the wedge story landing fast. **Recommend
B** if you want dispatcher integration unblocked first; the
fast-followers (groq/openrouter/ollama/deepseek) become trivial after
3.2.5 ships the path-based-model abstraction.

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
- **NEW (Phase 3.6):** before logging matched secret substrings
  anywhere — the policy default is detector-name-only. The matched
  substring is the literal secret you're trying to keep out of logs.

---

## Useful commands

```sh
# from keybroker
git log --oneline -5                       # most recent commit at the tip
npx vitest run                             # 375 tests, ~22s
npm run typecheck                          # clean

# manual smoke (requires `keybroker init` first + an issued, used token)
keybroker forecast                          # tokens, default 14d window
keybroker forecast --top 5 --since 7d       # tighter window
keybroker forecast --by team                # tag leaderboard, team bucket
keybroker forecast --by project --json      # machine-parseable

# HTTP equivalents (broker on default 127.0.0.1:7843):
curl 'http://127.0.0.1:7843/forecast/tokens'
curl 'http://127.0.0.1:7843/forecast/tokens?since=7d&top=5'
curl 'http://127.0.0.1:7843/forecast/tags?bucket=team'
curl 'http://127.0.0.1:7843/forecast/tags?bucket=project&since=30d'
```

---

## Final state

- Working tree clean once the Phase 3.5 commit lands.
- 375 tests green, typecheck clean.
- Plan file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  unchanged — Phase 3.5 spec there matches what shipped (with the
  `forecastTokens` / `forecastTags` route names + a 14d default).

Take your time.
