# Handoff — keybroker Phase 4.0 commit 1 complete (2026-05-10)

You are the next instance. Phase 4.0 (real frontend) is now started — the
scaffold and the Dashboard screen wired to real data shipped as a single
commit. The 3.x roadmap is closed; this opens 4.x.

The big picture for 4.0: retire `Prototype.html` by shipping a bundled
React app that the broker serves at `/ui`. The prototype's six screens
will land progressively over the next handful of commits. This commit
is the foundation — build pipeline, static-serve, design tokens, and
one fully-real screen.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Web scaffold | `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html` (new) | Vite + React 18 + TS. Separate package from the broker — `npm install` in `web/` brings its own `node_modules`. `tsconfig.json` mirrors broker's strict posture (strict, noUncheckedIndexedAccess, isolatedModules, noEmit). `vite.config.ts` sets `base: "./"` so the same `dist/` works whether the broker mounts it or you `vite preview` it. |
| Design tokens | `web/src/styles.css` (new) | All CSS variables from `Prototype.html` carried over verbatim — same Ink/Paper/Surface/Lime palette. Future screens reuse the same `var(--*)` names. |
| Entry + nav | `web/src/main.tsx`, `web/src/App.tsx` (new) | StrictMode root. Left rail with one active item (Dashboard) and a "Coming next" list pre-tagging the five remaining screens to their planned commits. Keeps the surface honest about what's real vs. coming. |
| API client | `web/src/api/client.ts` (new) | Two functions: `fetchHealth()`, `fetchSpend(bucket, since, limit)`. No auth header — same trust posture as the broker's other dashboard routes (127.0.0.1-only). Types mirror the broker's response shapes. |
| Dashboard screen | `web/src/components/Dashboard.tsx`, `StatCard.tsx`, `TagSpendCard.tsx` (new) | Four stat cards (active tokens, calls 24h, spend 24h, broker health/version) + three tag-rollup cards (team / project / env) + machine-spend list. 10s polling refresh. Error states are explicit (no silent zeros). Empty states say "no priced calls in window". |
| Static serve | `src/server.ts` | New imports: `@fastify/static`, `node:fs.existsSync`, `node:path`, `node:url.fileURLToPath`. New `resolveWebDistDir()` helper looks for `web/dist/index.html` relative to the source file's `import.meta.url`. If present, registers `@fastify/static` at `/ui/` (no `decorateReply` so we don't clash with the Fastify reply API the proxy routes use). If absent, mounts a fallback at `/ui/*` that serves a single-page hint HTML (the `UI_NOT_BUILT_HTML` constant). Either branch redirects `/ui` → `/ui/`. |
| Top-level scripts | `package.json` | New: `web:install`, `web:build`, `web:dev`. Convenience wrappers over `npm --prefix web ...`. |
| Tests | `tests/ui-static.test.ts` (new, 3 tests) | `/ui/` serves HTML (asserts SPA shell or hint based on whether `web/dist/index.html` exists at test time), `/ui` → 302 → `/ui/`, the `/:provider/*` catch-all is **not** shadowed (a request to a random fake provider still gets the structured `unknown_provider` 404). |
| Docs | `README.md` | "Control plane prototype" section rewritten to describe the bundled UI, the build steps, and Vite dev-server mode. Old prototype kept for reference until 4.0 reaches feature parity. |

**Tests:** 464 pass / 21 files (was 461 → +3 from `ui-static.test.ts`).
**`npm run typecheck`:** clean (broker side).
**`cd web && npm run build`:** clean. Bundle is 151 KB JS / 48 KB gzipped.

---

## Decisions locked in (don't re-litigate)

1. **`web/` is a peer package, not a workspace.** Separate `package.json`, own `node_modules`. The broker doesn't need to know about web/ at runtime — it just looks for `dist/`. Workspaces would add `package-lock` complexity and pull React types into the broker's TS context. Re-evaluate when 4.1 (TUI) lands; two peer packages is fine, three might motivate workspaces.
2. **No auth on the read-only Dashboard endpoints.** `/health` and `/metrics/spend` are intentionally open on 127.0.0.1 (the broker binds 127.0.0.1 only). The UI inherits that posture. When write operations (issue / revoke / rotate-all) land in a later commit, they will need a different auth design — see "Open question 1" below.
3. **Fallback page when `web/dist` is missing.** Operator might `git clone` and run `npm run serve` without building the UI. Crashing the server or 404-ing /ui at runtime would be hostile. The hint page tells them exactly which command to run.
4. **`/ui` and `/ui/` both work.** Bare `/ui` redirects to `/ui/` (302). Without this, a typed-by-hand URL with no trailing slash 404s — the file-server-style behavior most operators expect.
5. **Route order: static must register before the provider catch-all.** `/:provider/*` would otherwise capture `/ui` with `provider=ui` and return `unknown_provider`. Asserted in `tests/ui-static.test.ts` ("does not shadow the provider proxy catch-all"). If you ever move route registration around, that test will catch the regression.
6. **`decorateReply: false` on the @fastify/static registration.** The proxy routes (`/:provider/*`) use Fastify's reply API extensively; the static plugin's default `reply.sendFile` decoration would shadow nothing today but is unnecessary surface area. Keeping the decoration off is cheap insurance.
7. **CSS variables, not Tailwind, not styled-components.** The prototype's design system is already a coherent palette of CSS vars. Carrying it verbatim into `web/src/styles.css` keeps the visual language consistent and avoids a build-time CSS-in-JS dependency. Components inline `style={{ ... }}` for one-off layouts — same pattern as the prototype.
8. **No router yet.** One screen, one state variable. When the second screen lands (Tokens, in commit 2), evaluate React Router vs. a hand-rolled view switcher. The prototype used a hand-rolled switcher and it was fine.
9. **No state management library.** `useState` + `useEffect` is sufficient through Phase 4.0. If 4.1 introduces shared state across more than two screens, consider Zustand or TanStack Query — but not yet.
10. **Recharts in deps, not yet in bundle.** Declared in `web/package.json` because the Forecast and Latency screens will need it (Phase 4.0 c3). Vite tree-shakes unused exports, so it doesn't bloat the current 151KB bundle. Drop it from deps if c3 ends up using a lighter chart library.

---

## Files of note

| File | What |
|---|---|
| `web/src/api/client.ts` | The single source of truth for endpoint shapes on the frontend side. When you add `/tokens` and `/audit` GET endpoints in commit 2, mirror the broker types here. |
| `web/src/components/Dashboard.tsx` | Reference shape for future screens — useEffect + polling + cancellation flag, explicit error/loading/empty states. |
| `src/server.ts:resolveWebDistDir` | The bridge between the two packages. If you ever move `web/`, update this single helper. |
| `tests/ui-static.test.ts` | Template for testing future routes that mount React-app sub-paths. The "does not shadow the provider catch-all" test is load-bearing — keep that pattern when adding new top-level routes. |

---

## What to do next

### Commit 2 — Tokens + Audit screens (read-only)

Adds two screens and two GET endpoints. Largest piece of remaining 4.0 work.

**Scope:**
1. `GET /tokens` — returns `TokenRecord[]` from `store.listTokens()`. No filtering at the route level yet; filter client-side. Same 127.0.0.1 trust posture as /metrics/spend.
2. `GET /audit?limit=&token=&machine=&since=` — returns `CallLogEntry[]` from `store.recentCalls(...)`. The store method already takes `{limit, tokenId, machine}`; add `since` as an ISO timestamp filter (new store method, or filter post-fetch — discuss before adding).
3. `web/src/components/TokensScreen.tsx` — list with tag pills, machine, cap, spend-vs-cap progress bar (read `spendUsd` from `store.sumCostUsdByToken`, exposed via a per-token endpoint or computed alongside `/tokens`).
4. `web/src/components/AuditScreen.tsx` — table view, click-to-expand row, prompt/response NOT shown (the broker doesn't store bodies; only metadata). Highlight `egress_blocked` rows.
5. New tests: route-shape tests for the two endpoints (mirror `tests/proxy.test.ts` setup), one snapshot per screen via the existing render-test pattern (or skip — there's no react test util in deps yet; the broker-side tests suffice).

**Stop and check in:** before adding any write endpoint. Write operations (issue / revoke) need an auth design that read-only endpoints don't. See Open question 1.

### Commit 3 — Forecast + Policy + Shadow AI

Wires the remaining three screens to existing endpoints. Smallest commit of the three.

**Scope:**
1. `ForecastScreen.tsx` wired to `/forecast/tokens` and `/forecast/tags` — Recharts line chart for the regression projection.
2. `PolicyScreen.tsx` — `GET /policy` returns the current `policy.json` content (read-only; editing comes in a later phase). Render as a structured display, not raw JSON.
3. `ShadowAIScreen.tsx` — filter `/audit` for `outcome === "egress_blocked"`. The detector-name-only invariant (Phase 3.6 decision) means the UI shows what type of secret was blocked, not the matched bytes.
4. Delete `Prototype.html` and prune the README reference.

### Commit 4 (optional) — Write operations + management auth

If Phase 4.0 should include the rotation/issue UX (it should — that's the wedge), this is the auth design conversation. See Open question 1.

---

## Phase 4.0 c1 smoke test the next instance can run

```sh
# 1. Build the web bundle.
npm run web:install
npm run web:build

# 2. Boot the broker.
npm run serve
# (in another terminal)

# 3. Open the UI.
open http://127.0.0.1:7843/ui/
# Expected: dashboard with four stat cards. With no traffic, "Calls (24h)"
# and "Spend (24h)" show 0; "Active tokens" reflects whatever's in store.

# 4. Issue a couple of tokens and make a call so the dashboard has data.
keybroker token issue --provider echo --team platform --label demo-a
keybroker token issue --provider echo --team data     --label demo-b
TOKEN=$(keybroker token issue --provider echo --team platform --label demo-c --print-token)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  http://127.0.0.1:7843/echo/v1/chat/completions/usage \
  -d '{"upstream_usage":{"in":200,"out":100}}'

# 5. Refresh /ui/ — stat cards and tag rollup should update within 10s.

# 6. Sanity: confirm the dev-mode flow works.
npm run web:dev
# Vite serves the SPA on :5173 with HMR; /health is proxied to :7843.
```

If the dashboard hangs on "loading…", check:
- `npm run web:build` was run (otherwise the broker serves the hint page).
- Broker is bound to 127.0.0.1 (Vite proxy assumes this).
- `/health` returns 200 (curl it directly).

---

## Stop-and-check-in triggers (carry forward)

- Before changing `ExtractorInput` again — touches every provider's extractor.
- Before adding any auto-kill behavior to the broker sidecar. Spawn-and-leave is deliberate.
- Before shipping the `policy.json` `tag_allowlist` strict variant (the rejected option) — would force editing policy.json before any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` — hardcoded `KEYBROKER_BIN` default in dispatcher's `keybroker.mjs` assumes the dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` — `Date.parse` is permissive enough to be a footgun; add deliberately and validate strictly.
- Before logging the matched secret substring ANYWHERE — the policy default is detector-name-only, and the invariant is asserted in tests. If you find yourself wanting the matched bytes for a "better debug message", DON'T. Add a separate ops-only counter keyed by detector name instead.
- Before adding a sixth built-in detector, ask whether it has a fixed prefix or shape. Generic-entropy / arbitrary-base64 patterns belong in Layer 3, not Layer 1.
- Before flipping `scanner.enabled` to default-off, reread the Phase 3.6 decision log. The default-on posture is load-bearing for the wedge story.
- Before adding a third `authStyle` literal, ask whether `"header"` + a different `authHeader` covers it.
- Before flipping `KEYBROKER_ROUTE` to default-on, smoke-test against real upstreams.
- Before adding per-chunk inter-arrival timings to the audit row, see Phase 3.7 decision 2.
- Before allowing a no-filter `rotate-all`, reread Phase 3.8 decision 1. Full-fleet rotation in a single keystroke is a footgun.
- Before letting `rotate-all` extend a token's lifetime (reading `--ttl` as input, etc.), reread Phase 3.8 decision 2. Rotation preserves the existing TTL.
- Before silently dropping the lossy-models warning on `rotate-all`, reread Phase 3.8 decision 6.
- **Phase 4.0 (active):** before exposing any write operation in the UI, design the management-auth posture (see Open question 1). The current "no-auth on 127.0.0.1" posture is fine for *read*-only dashboards but is NOT a basis for issue/revoke/rotate-all over HTTP.
- **Phase 4.0 (active):** before adding a real router (React Router, TanStack Router) to `web/`, ask whether the screen-switching needs URLs that survive refresh, deep links, or back-button navigation. If not, a hand-rolled switcher is fine through 4.0.
- **Phase 4.0 (active):** before introducing TanStack Query or any data-fetching library, count the screens that need cross-screen cache invalidation. If it's still one or two, useState + useEffect remains the right call.

---

## Open questions for next instance

1. **Management auth.** The Dashboard read endpoints are fine on the existing "open on 127.0.0.1" posture. Write operations (issue / revoke / rotate-all) are not. Options:
   - **a. Localhost-only POST/DELETE** — same posture, trusting the loopback boundary. Cheap but means anything on the box can mint tokens. Probably acceptable for a personal-fleet tool; less so once the broker ever runs on a shared box.
   - **b. Management JWT** — separate signing secret, separate `/admin` namespace, manage-scope tokens minted only via CLI (which holds the secret). The UI prompts for a management token on first load and caches it in `sessionStorage`. Strongest posture, most ceremony.
   - **c. Unix-socket-only writes** — most secure but means the UI has to relay through a localhost shim. Probably not worth the complexity for a personal tool.
   Lean toward (b) — small ceremony, clear separation between "read" and "act". Decision belongs to the user, not commit 2.
2. **Should `Prototype.html` get deleted in commit 3 or kept indefinitely?** The plan says delete. Concern: if commit 3 misses any screen behavior the prototype demonstrated, deletion loses the reference. Suggestion: delete in commit 3 *if* commit 3 reaches functional parity with the prototype's six screens; otherwise keep until commit 4.

---

## Useful commands

```sh
# from keybroker root
npm run web:install              # one-time, installs web/node_modules
npm run web:build                # builds web/dist
npm run web:dev                  # vite dev server (with HMR)
npm run serve                    # broker on :7843; serves /ui/ if dist built
npx vitest run                   # 464 tests, ~43s
npx vitest run tests/ui-static.test.ts   # 3 tests, ~2s
npm run typecheck                # clean (broker side)
cd web && npm run typecheck      # clean (web side)
```

---

## Final state

- One commit on `main`: Vite + React scaffold (`web/`), Dashboard screen with real-data wiring, `@fastify/static` mount at `/ui/`, fallback hint when `dist/` absent, 3 new tests, README + scripts updated.
- 464 tests pass, both typechecks clean.
- The plan file's Phase 4.0 entry is partly delivered: scaffold ✅, design tokens ✅, one screen wired ✅. Tokens/Audit/Forecast/Policy/Shadow AI screens are commit-2/commit-3 work. Write operations are pending the management-auth decision.
- Recharts is declared in `web/package.json` but not yet imported — keep it through commit 3 (Forecast needs it).

Take your time.
