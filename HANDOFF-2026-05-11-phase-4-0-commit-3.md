# Handoff — keybroker Phase 4.0 commit 3 complete (2026-05-11)

You are the next instance. Phase 4.0 c3 (Forecast, Policy, Shadow AI
screens) shipped as a single commit. **The read-only frontend is
feature-complete** — all six prototype screens are now real, wired to
live data, and the bundled control plane at /ui is the new operator
surface. Working tree should be clean.

Commit chain: c1 `c10db68` (scaffold + Dashboard) → c2 `1166504`
(Tokens + Audit) → c3 (this commit) → c4 deferred (write operations,
needs management-auth decision).

---

## What landed

| Layer | File | Change |
|---|---|---|
| Endpoint: GET /policy | `src/server.ts` | New route. Wraps `loadPolicy(config.policyPath)` and returns the resolved `Policy` snapshot. Honors the existing TTL cache; same 127.0.0.1 trust posture as the rest of the read-only routes. Read-only — no PUT/POST/edit. |
| Frontend types | `web/src/api/client.ts` | New: `TokenForecastRow`, `TagForecastRow`, `ScannerConfig`, `PolicySnapshot`. New fetchers: `fetchTokenForecast`, `fetchTagForecast`, `fetchPolicy`. |
| Forecast screen | `web/src/components/ForecastScreen.tsx` (new) | Three panels: (a) **breach table** sorted by days-until-cap ascending with tone-coded countdown (red <1d, amber <7d, lime else), (b) **burn-leaders bar chart** (Recharts vertical bars) ranking tokens by USD/day slope, (c) **tag burn rate** horizontal bar chart with team/project/env switcher. Refreshes every 30s. |
| Policy screen | `web/src/components/PolicyScreen.tsx` (new) | Four structured cards (Scanner, Forbidden models, Allowed providers, Tag allow-list) instead of raw JSON. Scanner card highlights when enabled (lime border) and explicitly documents the `egress_blocked` outcome contract. Tag allow-list distinguishes "(any value)" from empty values. Refreshes every 30s. |
| Shadow AI screen | `web/src/components/ShadowAIScreen.tsx` (new) | Fetches up to 500 recent audit rows, filters to `outcome === "egress_blocked"`, groups by detector name (the `reason` field). Each detector becomes a card with count + unique tokens + unique machines + last-seen. Clicking a card expands an event list. Empty-state celebrates with "No secrets caught in the last 500 calls." Refreshes every 15s. |
| App lazy-loading | `web/src/App.tsx` | All three new screens wired into the nav. Forecast is `React.lazy()` + `Suspense` so its 378 KB Recharts chunk doesn't ship to operators who only look at Dashboard / Tokens / Audit / Policy / Shadow AI. Main bundle stays at 182 KB / 54 KB gz; the Forecast chunk loads on first navigation. |
| Tests | `tests/ui-routes.test.ts` | +1 test for `GET /policy` (returns the default empty-policy shape with `scanner.enabled: true`). Same `beforeAll` seed reused. |
| Footer | `web/src/App.tsx` | "Coming next" list trimmed to "Issue / rotate · 4.0 c4". Footer text bumped to "Phase 4.0 · c3 read-only complete". |

**Tests:** 472 pass / 22 files (was 471 → +1).
**`npm run typecheck`:** clean (broker).
**`cd web && npm run typecheck`:** clean (web).
**`cd web && npm run build`:** clean. Main bundle 182 KB / 54 KB gz (+14 KB from c2 for Policy + Shadow AI components). Forecast lazy-chunk 378 KB / 105 KB gz.

---

## Decisions locked in (don't re-litigate)

1. **Forecast screen is lazy-loaded; everything else is eager.** Recharts (and through it d3-scale, d3-shape, d3-path, etc.) is ~400 KB raw. The other five screens don't need any charting and shouldn't pay for the bundle. `React.lazy + Suspense` with a tiny fallback gives the best of both worlds.
2. **Policy screen is read-only.** No edit affordance. Even a "save" button would lure operators into believing the broker reload was atomic — which it is per the policy cache TTL, but the diff-vs-current vs. diff-vs-disk story is non-trivial. Editing belongs in a deliberate Phase 4.0+ commit, not as a quiet "+1 feature".
3. **Shadow AI groups by detector name, not by token or machine.** The wedge story is "what types of secrets are leaking into prompts?" — that's a detector-name aggregation. Token / machine breakdowns are secondary cuts inside the expanded card. Don't flip the primary axis.
4. **Shadow AI fetches limit=500 and filters client-side.** Same posture as c2 decision 3 (search/filter are client-side because the audit window is bounded). If a single fleet routinely produces >500 egress-blocked events in the polling interval, that's not a UI problem — that's a "the scanner is firing constantly, someone go look at what's happening" problem.
5. **Bundle warning was real, not noise.** A 559 KB chunk shipping on first paint to a control plane the operator might never even open is bad citizenship. Lazy-loading the only chart-heavy screen is the principled fix; bumping `chunkSizeWarningLimit` would be papering over it.
6. **Policy screen distinguishes "(any value)" from "(empty — nothing accepted)" for tag allow-lists.** The policy module treats both empty array and missing key as "unrestricted" — but the UI gets these from the same field. Show "(any value)" so operators don't read an empty list as "I locked it down" when they actually unlocked it.
7. **Shadow AI's empty state is a "no leaks caught" celebration, not a "loading" or "no data" message.** The product narrative is "the scanner is working — nothing got through." That message should be the same color (lime / success) as the green status pill, because that's what it means.
8. **Did NOT delete `Prototype.html` in this commit.** The prototype's "Recovery checklist" affordance (mid-incident workflow walkthrough) has no equivalent in the bundled UI. Deleting now loses the reference. Revisit at c4: when write operations land and Recovery Checklist gets a real implementation, delete the prototype then.

---

## Files of note

| File | What |
|---|---|
| `web/src/components/ForecastScreen.tsx` | Has the Recharts integration pattern — `ResponsiveContainer` wrapper, theme-aware tick / grid / tooltip colors using CSS vars. Reuse pattern for any future chart. |
| `web/src/components/PolicyScreen.tsx` | `PolicyCard` is a generic "labeled section with optional highlight" wrapper. Steal for any future settings / config display. |
| `web/src/components/ShadowAIScreen.tsx` | `DetectorBucket` aggregation logic in `useMemo` — pure-function, easy to unit-test if needed. The hover-card with active state inside a grid is the template for any future "tab as counter" pattern (alongside `OutcomePill` in `AuditScreen.tsx`). |
| `web/src/App.tsx` | Now has a lazy-loaded route. If you add another chart-heavy screen, follow the same pattern; if you start adding more, consider promoting to a real router. |
| `src/server.ts` | All five read-only routes now in one stretch (115–250-ish): `/metrics/spend`, `/metrics/latency`, `/tokens`, `/audit`, `/policy`, `/forecast/tokens`, `/forecast/tags`. If write routes land, group them separately so the management-auth boundary is visually obvious. |

---

## What to do next

### Commit 4 — Write operations + management auth (THE big conversation)

The wedge story isn't complete until the UI can mint, revoke, and rotate. But that needs an auth design first. See open question 1 in HANDOFF-2026-05-10-phase-4-0-commit-1.md:

- **Option a — Localhost trust extends to writes.** Cheap. Probably wrong. Anything on the box can mint tokens over plain HTTP.
- **Option b — Management JWT, separate signing secret, `/admin` namespace.** UI prompts for a management token on first load, caches in `sessionStorage`. Smallest ceremony that gives genuine separation between "read" and "act".
- **Option c — Unix-socket-only writes via a localhost shim.** Most secure, most complexity. Probably overkill for a personal-fleet tool.

Lean (b). The user decides.

**Once auth is settled, c4 work is:**
1. New `/admin/tokens` POST (issue), DELETE /admin/tokens/:id (revoke), POST /admin/tokens/rotate (calls into Phase 3.8's `rotate-all`).
2. Management-token CLI: `keybroker token mgmt --issue --label dashboard --ttl 8h` returns a `mgmt-<id>` JWT.
3. UI: token-prompt modal on first load. Issue button on Tokens screen. Revoke button in token detail panel. Rotate-all dialog with blast-radius preview (the prototype's UX, now real).
4. Recovery Checklist screen — incident-response workflow. THIS is the screen with no current backend equivalent; design before implementing.
5. Delete `Prototype.html`. Reach functional parity in c4 first, *then* delete.

### Commit 4.1 — Cleanup + polish (smaller)

Anything that emerges from real use of c3. Possible items:
- Keyboard shortcuts (search-focus, screen-switch).
- Active-screen URL fragment so refresh preserves view.
- Dark/light theme toggle (palette already supports it via CSS vars — would need a `theme="light"` token swap).
- Real router (React Router) if c4's add-screen complexity warrants it.

These are nice-to-haves. Skip unless they're load-bearing.

### Other Phase 4 options

- **Phase 4.1 — TUI variant** (Ink + Yoga). Now well-supported by the data layer. Right move if the operator workflow is terminal-first.
- **Phase 4.2 prep — scanner Layer 2/3 deep research.** TruffleHog + Presidio. Prompt already drafted in `Claude-Deep-Research-Prompt.md`.

---

## Phase 4.0 c3 smoke test the next instance can run

```sh
# 1. Build the web bundle and seed data.
npm run web:install   # idempotent
npm run web:build

# Multiple tokens across teams + tags, with caps.
keybroker token issue --provider openai --team platform --project ci --label ci-platform --cap-usd 10
keybroker token issue --provider openai --team data --label data-pipeline --cap-usd 5
keybroker token issue --provider echo --team platform --label echo-test
TOKEN_LEAKY=$(keybroker token issue --provider echo --team data --label leaky-bot --print-token)
TOKEN_BURNY=$(keybroker token issue --provider echo --team platform --label burny --print-token --cap-usd 0.01)

# 2. Generate some traffic so forecast has signal.
for i in {1..20}; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN_BURNY" \
    -H "content-type: application/json" \
    http://127.0.0.1:7843/echo/v1/chat/completions/usage \
    -d '{"upstream_usage":{"in":200,"out":100}}' > /dev/null
done

# 3. Trip the scanner.
for i in {1..3}; do
  curl -s -X POST -H "Authorization: Bearer $TOKEN_LEAKY" \
    -H "content-type: application/json" \
    http://127.0.0.1:7843/echo/v1/chat/completions \
    -d '{"messages":[{"role":"user","content":"AKIAIOSFODNN7EXAMPLE here is my key"}]}' > /dev/null
done

# 4. Boot and visit each screen.
npm run serve  # in another shell

# Visit, in order:
#   http://127.0.0.1:7843/ui/#forecast → cap-breach table flags `burny`.
#   /ui/#policy → Scanner card lime-bordered, "enabled". Tag allow-list shows "(any value)".
#   /ui/#shadow → "aws_access_key" detector card with count: 3, 1 token, 1 machine.

# 5. Optional: edit policy.json to add a forbidden model.
cat > ~/.keybroker/policy.json <<'EOF'
{
  "forbidden_models": ["gemini-3-pro-preview", "*-preview"],
  "allowed_providers": ["openai", "anthropic", "echo"]
}
EOF
# Wait 2s for the policy cache TTL, refresh /ui/#policy → forbidden models pill list shows both.
```

If a screen 4xxs:
- `/forecast` requires audit rows for at least one token within the 14d window. Seed some.
- `/policy` always returns 200 (returns defaults when file absent).
- `/shadow` is silent (empty state) until at least one `egress_blocked` row exists.

---

## Stop-and-check-in triggers (carry forward — c3 additions)

All prior triggers still apply. New c3 entries:

- **Phase 4.0 (active):** before adding an editor to the Policy screen, design the apply-and-reload story. Naively rewriting `policy.json` is unsafe (concurrent edits, partial writes, parse errors). The CLI command pattern (`keybroker policy set forbidden-model "..."`) is the safer base for any UI affordance.
- **Phase 4.0 (active):** before changing the Shadow AI grouping axis from detector to token/machine, reread c3 decision 3. The wedge story is detector-name first.
- **Phase 4.0 (active):** before adding another chart-heavy screen, follow the lazy-loading pattern. The eager bundle should not exceed ~250 KB / ~75 KB gz.
- **Phase 4.0 (active):** before exposing the matched bytes ANYWHERE in Shadow AI or audit detail, STOP. Phase 3.6 invariant. The broker has no source for the matched substring; if you find yourself adding a field, you are misreading the spec.

---

## Useful commands

```sh
npm run web:install              # one-time
npm run web:build                # main 182 KB / forecast lazy 378 KB
npm run web:dev                  # vite dev with HMR
npm run serve                    # broker on :7843; /ui/ now has 6 working screens
npx vitest run                   # 472 tests, ~40s
npx vitest run tests/ui-routes.test.ts    # 8 tests (added /policy)
npm run typecheck                # broker
cd web && npm run typecheck      # web
```

---

## Final state

- One commit on `main`: GET /policy endpoint, three new screens (Forecast/Policy/Shadow AI), Forecast lazy-loaded, App nav fully wired, +1 endpoint test.
- 472 tests pass, both typechecks clean.
- Phase 4.0 progress: scaffold ✅, Dashboard ✅, Tokens ✅, Audit ✅, Forecast ✅, Policy ✅, Shadow AI ✅. **Read-only is feature-complete.** Write operations are c4 work pending the management-auth decision.
- `Prototype.html` retained for reference until c4 reaches parity (Recovery Checklist gap).
- Push status: branch is ahead of origin/main by three commits (c10db68, 1166504, and this c3 commit). User pushes manually.

Take your time.
