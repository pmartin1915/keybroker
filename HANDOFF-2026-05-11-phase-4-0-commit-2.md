# Handoff — keybroker Phase 4.0 commit 2 complete (2026-05-11)

You are the next instance. Phase 4.0 c2 (Tokens + Audit screens, read-
only) shipped as a single commit. The bundled control plane now has
three working screens served from /ui — Dashboard, Tokens, Audit —
and the matching read endpoints. Working tree should be clean after
the commit.

Commit 1 reference: `c10db68`. Commit 2 (this commit) builds on it
without changing any c1 decisions.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Endpoint: GET /tokens | `src/server.ts` | New route. Returns `Array<TokenRecord & { spendUsd }>`. Optional `?machine=` filter via existing `store.listTokens({machine})`. Augments each record with `store.sumCostUsdByToken(id)` so the UI can render a cap-vs-spend bar without a per-row round trip. Same 127.0.0.1 trust posture as `/metrics/*` and `/forecast/*`. |
| Endpoint: GET /audit | `src/server.ts` | New route. Wraps `store.recentCalls({limit, tokenId, machine})`. Default limit 100, max 1000 (rejects out-of-range with `invalid_limit`). Optional `?token=` and `?machine=` filters mirror the CLI's `keybroker audit` surface. |
| Frontend types | `web/src/api/client.ts` | New `TokenRow` (mirrors broker `TokenRecord` + `spendUsd`) and `AuditRow` (mirrors `CallLogEntry`). New fetchers: `fetchTokens(opts?)`, `fetchAudit(opts?)`. URLSearchParams composition is omit-when-absent so empty queries don't carry trailing `?`. |
| Tokens screen | `web/src/components/TokensScreen.tsx` (new) | Table with label/id, provider, tags + machine pills, calls, spend-vs-cap progress bar, expiry-shorthand ("3d", "12h", "expired", "never"). Filter pills (Active / Revoked / All) + freetext search across label/id/provider/machine/tags. Click a row → right-side detail panel with full claim summary. Refreshes every 15s. |
| Audit screen | `web/src/components/AuditScreen.tsx` (new) | Table with timestamp, provider, method, path, status, TTFT, cost (actual or estimated), outcome. Five outcome filter pills (All / OK / Denied / Error / Egress blocked) double as counters. Freetext search. Click a row → right-side detail panel exposing every audit field including TPOT and output tokens. Refreshes every 10s. **`egress_blocked` rows surface in their own filter** — the wedge story. |
| App nav | `web/src/App.tsx` | Three live nav items now (Dashboard, Tokens, Audit). Footer bumped to "Phase 4.0 · c2 read-only". Coming-next list trimmed to Forecast / Policy / Shadow AI for c3. |
| Tests | `tests/ui-routes.test.ts` (new, 7 tests) | `GET /tokens` returns three tokens with correct `spendUsd` augmentation (a=$2.00, b=$0, c=$0 because all of b's calls were denied/egress-blocked); `?machine=` filter; `GET /audit` recency order, `?limit=` bound, `invalid_limit` rejection, `?token=`/`?machine=` filters. |

**Tests:** 471 pass / 22 files (was 464 → +7).
**`npm run typecheck`:** clean (broker side).
**`cd web && npm run typecheck`:** clean (web side).
**`cd web && npm run build`:** clean. Bundle is 168 KB JS / 51 KB gzipped (was 151/48 in c1; +17 KB for two screens — most of it the detail panels).

---

## Decisions locked in (don't re-litigate)

1. **`/tokens` includes `spendUsd` inline via N×`sumCostUsdByToken`.** Not a single aggregate SQL query. For the personal-fleet sizes this codebase targets (<200 tokens), the indexed-sum cost is fine. If a future operator runs a fleet of 1000+, add a single `sumCostUsdByToken_all()` store method and have the route call that — but only then. Premature, otherwise.
2. **`/audit` has NO `since` filter.** The store's `recentCalls` doesn't expose one. Adding it would require a new store method (`recentCallsSince`) or in-memory filter after fetching extra rows. Neither earns its complexity yet — the UI fetches 200 rows by default and renders them; if the operator wants a time-bounded view, that's a c4+ feature alongside any column sort / pagination work.
3. **Search/filter for both screens is client-side.** The broker returns the slice; the React component does the searching. Cheap, instant, no extra round trips. If a future "search across 10k+ rows" use case emerges, push it down — but the audit table is intentionally bounded to ~200.
4. **Token detail panel and audit detail panel are slide-out drawers, not modals.** Reading a token's claims while scrolling a long list is the common case; a centered modal blocks the list. Same pattern is reusable for the Policy screen in c3.
5. **`egress_blocked` outcome surfaces in its own filter pill, NOT folded into "Denied".** They look similar (both rejected before upstream) but the wedge story needs them visually distinct — egress-blocked is what makes keybroker different. The pill is colored `--accent-rose` and the row's outcome label inherits that color.
6. **The audit detail panel never displays the matched secret bytes.** Phase 3.6 invariant: `reason` carries detector name only. The UI doesn't even have a field for "matched substring" because the broker doesn't have one. If you find yourself adding a "view the matched bytes" affordance, STOP and reread `decision_phase_3_6_scanner.md`.

---

## Files of note

| File | What |
|---|---|
| `src/server.ts:/tokens, /audit handlers` | New routes are co-located with `/metrics/latency` (the previous read-only route). Co-location is intentional — if a future commit adds management auth, sweep the whole block. |
| `web/src/api/client.ts` | Frontend type contract mirrors broker types. When you change `TokenRecord` or `CallLogEntry`, update here too. |
| `web/src/components/TokensScreen.tsx` | Has the table-grid layout pattern that future screens (audit replays, recovery checklists) should reuse — `display: grid` with column-fr template, header row + data rows in the same grid. |
| `web/src/components/AuditScreen.tsx` | The `OutcomePill` component is the template for any future "tab-as-counter" pattern. |
| `tests/ui-routes.test.ts` | Lightweight pattern for testing additive read endpoints — single `beforeAll`, fixed seed data, multiple `describe` blocks per route. Reuse for `/policy` and `/scanner/leaks` in c3. |

---

## What to do next

### Commit 3 — Forecast + Policy + Shadow AI

Wires the three remaining prototype screens. All read-only.

**Scope:**
1. `ForecastScreen.tsx` — wired to `/forecast/tokens` (cap-projection per token) and `/forecast/tags` (per-tag burn rate). This is where Recharts finally pays for itself: a line chart of cumulative spend vs. capacity, projection line dashed past `now`. Per-token forecast is the more useful one operationally.
2. `PolicyScreen.tsx` — new `GET /policy` endpoint returns the active `policy.json` content. The route's the easy part; the UI should NOT render raw JSON — instead structure it: forbidden models, allowed providers, scanner config, tag allow-list. Read-only display only. (Edit affordance is later.)
3. `ShadowAIScreen.tsx` — reuses `/audit` with `outcome=egress_blocked` filter applied client-side, then groups by detector name (i.e. by `reason`). Show a leaderboard: which detector fired most, which token tripped it, which machine. NO matched-bytes display (see c2 decision 6).
4. **Optional: delete `Prototype.html`.** If c3 reaches functional parity with the prototype's six screens, delete it and prune the README reference. If parity gaps remain (e.g., recovery checklist), keep it for reference; revisit at c4.

**Stop and check in:** before adding any write endpoint. The Policy screen edit feature, Token issue/revoke, and rotate-all UX all need the management-auth decision (open question 1 in HANDOFF-2026-05-10-phase-4-0-commit-1.md). Don't ship a write endpoint as part of c3.

### Commit 4 (deferred) — Write operations + management auth

The wedge story is "real rotation UX." That needs:
- An auth design (the open question — see c1 handoff).
- POST/DELETE endpoints that the UI can hit safely.
- A confirmation modal for destructive operations (revoke, rotate-all).

This is the conversation worth pausing for. Don't pick option (a) "localhost trust" by default — the security narrative of the product clashes with "anything on the box can mint a token over plain HTTP."

---

## Phase 4.0 c2 smoke test the next instance can run

```sh
# 1. Build the web bundle.
npm run web:install
npm run web:build

# 2. Seed some data.
keybroker token issue --provider openai --team platform --label demo-platform-a --cap-usd 5
keybroker token issue --provider openai --team data     --label demo-data-a
TOKEN=$(keybroker token issue --provider echo --team platform --label demo-echo --print-token)

# 3. Generate a few calls so audit has rows.
for i in 1 2 3; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    http://127.0.0.1:7843/echo/v1/chat/completions/usage \
    -d '{"upstream_usage":{"in":100,"out":50}}' > /dev/null
done

# 4. Trigger an egress_blocked outcome.
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  http://127.0.0.1:7843/echo/v1/chat/completions \
  -d '{"messages":[{"role":"user","content":"AKIAIOSFODNN7EXAMPLE here"}]}' > /dev/null

# 5. Boot the broker.
npm run serve

# 6. Open the UI.
open http://127.0.0.1:7843/ui/
# Expected:
#   - Dashboard: spend bar by team shows "platform" leading.
#   - Tokens screen: filter for "demo-" finds three; click one for detail.
#   - Audit screen: "Egress blocked" pill shows 1+; filter to see only that row.
```

---

## Stop-and-check-in triggers (carry forward — c2 additions)

All c1 triggers still apply. New c2 entries:

- **Phase 4.0 (active):** before exposing any write operation (POST /tokens, DELETE /tokens/:id, etc.), design the management-auth posture. The c1 read-only posture (open on 127.0.0.1) is fine for fetches; it is NOT a basis for mint/revoke over HTTP. See open question 1 in HANDOFF-2026-05-10-phase-4-0-commit-1.md.
- **Phase 4.0 (active):** before adding any `since` parameter to `/audit`, ask whether the existing `limit` + client-side filter is actually insufficient. Audit pagination + time-window filtering is a feature, not a fix.
- **Phase 4.0 (active):** before displaying the matched-substring of a scanner hit in the UI, STOP. The Phase 3.6 detector-name-only invariant is load-bearing. The audit row has no `matchedBytes` field and the broker has no source for one. If you find yourself adding a field, you are misreading the spec.
- **Phase 4.0 (active):** before adding a sort affordance to the audit table, decide whether the table is bound to ~200 rows or whether sort means re-fetching. Client-side sort over a fixed window is cheap; pagination + remote sort is materially different work.

---

## Useful commands

```sh
npm run web:install              # one-time
npm run web:build                # builds web/dist
npm run web:dev                  # vite dev server with HMR
npm run serve                    # broker on :7843
npx vitest run                   # 471 tests, ~42s
npx vitest run tests/ui-routes.test.ts    # 7 tests, ~2s
npx vitest run tests/ui-static.test.ts    # 3 tests, ~2s
npm run typecheck                # broker
cd web && npm run typecheck      # web
```

---

## Final state

- One commit on `main`: two new read-only endpoints (`/tokens`, `/audit`), two new screens (Tokens, Audit), seven new tests.
- 471 tests pass, both typechecks clean.
- Phase 4.0 progress: scaffold ✅ (c1), Dashboard ✅ (c1), Tokens ✅ (c2), Audit ✅ (c2). Remaining: Forecast (c3), Policy (c3), Shadow AI (c3), write operations (c4 — pending auth decision).
- Recharts still declared in deps, still not imported. It earns its keep in c3 (Forecast line chart). If c3 ends up using a smaller lib, drop Recharts then.
- Push status: branch is ahead of origin/main by two commits (c10db68, and this c2 commit). User pushes manually.

Take your time.
