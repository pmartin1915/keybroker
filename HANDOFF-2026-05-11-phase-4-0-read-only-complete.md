# Handoff — keybroker Phase 4.0 read-only frontend COMPLETE (2026-05-11)

You are the next instance. **Phase 4.0 read-only is shipped and pushed.**
Three commits landed in a single session and are now on `origin/main`.
The bundled React control plane at `/ui` is the new operator surface.
All six prototype screens are real, wired to live data, and feature-
complete on the *read* axis.

Working tree clean. `origin/main` is at `8dbbb26`.

The conversation worth pausing for: **management-auth design**, the
prerequisite for any write operations (issue / revoke / rotate-all
UX). That decision belongs to the user, not the next instance.

---

## Commit chain pushed this session

| Commit | Phase | What |
|---|---|---|
| `c10db68` | 4.0 c1 | Vite + React 18 + TS scaffold under `web/`. `@fastify/static` mount at `/ui` with fallback "not built" HTML. Dashboard wired to `/health` + `/metrics/spend`. +3 tests. |
| `1166504` | 4.0 c2 | `GET /tokens` (with `spendUsd`) and `GET /audit`. TokensScreen (filter pills, tag/machine/cap display, slide-out detail). AuditScreen (five-outcome filter pills, egress_blocked surfaced separately). +7 tests. |
| `8dbbb26` | 4.0 c3 | `GET /policy`. ForecastScreen (Recharts: breach table + burn leaders + tag burn). PolicyScreen (structured cards). ShadowAIScreen (detector-name aggregation, "no leaks caught" empty state). Forecast lazy-loaded. +1 test. |

**Tests:** 461 at session start → **472 now (+11)**. Both broker and web typechecks clean.

**Bundle:** main 182 KB / 54 KB gz · Forecast lazy chunk 378 KB / 105 KB gz.

---

## Per-commit handoffs (read these for full decision context)

The three commit-specific handoffs are committed alongside their code. Read in order if you need the full thread:

1. `HANDOFF-2026-05-10-phase-4-0-commit-1.md` — c1. Foundation. 10 architecture decisions including the c4 management-auth open question (the one that needs the user's input before write ops land).
2. `HANDOFF-2026-05-11-phase-4-0-commit-2.md` — c2. Tokens + Audit. 6 decisions including N+1 spendUsd compute trade-off, client-side filtering posture, egress_blocked as its own outcome-pill.
3. `HANDOFF-2026-05-11-phase-4-0-commit-3.md` — c3. Forecast/Policy/Shadow AI. 8 decisions including Forecast lazy-load, Policy read-only deliberate, Shadow AI detector-first axis, Prototype.html retention.

The c1 and c2 handoffs were committed pre-push as part of their respective commits. The c3 handoff was also bundled with its commit. This post-push handoff (the one you're reading) is the meta-pointer.

---

## What's real at `/ui` now

```
http://127.0.0.1:7843/ui/
├─ Dashboard      stat cards, tag-rollup cards, machine-spend list — all live
├─ Tokens        filterable table, tag pills, cap/spend bars, slide-out detail
├─ Audit         five-outcome filter pills (incl egress_blocked), per-row TTFT + cost
├─ Forecast      breach countdown table, burn-leader bar chart, tag burn switcher
├─ Policy        scanner card (lime when enabled), forbidden models, allowed providers,
│                tag allow-list with "(any value)" disambiguation
└─ Shadow AI     detector-name buckets, click-to-expand event list, "no leaks" empty state
```

Every screen has independent polling, explicit error/empty states, and the prototype's CSS variable palette. No matched-secret-bytes displayed anywhere (Phase 3.6 invariant respected).

---

## What's NOT real at `/ui` (intentional)

- **Issue / revoke / rotate-all buttons.** No UI write ops. The wedge story is incomplete until they land. Blocked on the management-auth decision.
- **Policy edit.** The Policy screen is read-only. Editing needs a deliberate apply/reload story (see c3 decision 2).
- **Recovery Checklist screen.** The prototype demonstrates this; the broker has no current backend equivalent. Design before implementing in c4.
- **Token detail "revoke this" affordance.** Blocked by management-auth.

`Prototype.html` is retained as the reference for these gaps. Delete when c4 reaches parity.

---

## The pending decision — management-auth (open question 1 from c1)

Three options summarized; full text in `HANDOFF-2026-05-10-phase-4-0-commit-1.md`.

**Option (a) — Localhost-only POST/DELETE.** Cheapest. Trusts that anything on the loopback can mint tokens over plain HTTP. Probably wrong for a credential broker — the security narrative clashes.

**Option (b) — Management JWT (RECOMMENDED).** Separate signing secret, `/admin/*` namespace, manage-scope tokens minted via CLI only. UI prompts for the management token on first load, caches in `sessionStorage`. Smallest ceremony that gives genuine read vs. act separation.

**Option (c) — Unix-socket-only writes via localhost shim.** Strongest. Most complexity for a personal-fleet tool. Probably overkill.

**Recommend (b).** The user picks.

Once that's settled, c4 work is:

1. `keybroker token mgmt --issue --label dashboard --ttl 8h` CLI subcommand to mint management JWTs.
2. New routes: `POST /admin/tokens` (issue), `DELETE /admin/tokens/:id` (revoke), `POST /admin/tokens/rotate` (calls into 3.8's `rotate-all`).
3. UI: token-prompt modal on first load. Issue button on Tokens screen. Revoke in token detail panel. Rotate-all dialog with blast-radius preview (the prototype's UX, now real).
4. Recovery Checklist screen — incident-response workflow.
5. Delete `Prototype.html`.

---

## Other reasonable next phases (if c4 management-auth is deferred)

- **Phase 4.1 — TUI variant** (Ink + Yoga). Status bar pinned (spend / active tokens / current machine), same color palette. Now well-supported by the data layer.
- **Phase 4.2 prep — scanner Layer 2/3 deep research.** TruffleHog + Presidio architecture. Prompt drafted in `Claude-Deep-Research-Prompt.md`. *Non-blocking research deliverable*, not implementation.
- **Phase 3.2 c4 smoke** — the dispatcher's broker-routing change was never smoked against a real upstream. `KEYBROKER_ROUTE` defaults off; flipping default-on needs a verification run against gemini + mistral with real keys.

---

## Smoke test (verifies the pushed state)

```sh
# From the repo root, on `main` at 8dbbb26.
npm run web:install   # one-time
npm run web:build     # main bundle + forecast lazy chunk
npm run serve         # broker on :7843

# Open http://127.0.0.1:7843/ui/ — Dashboard should render four stat cards
# with zeros / em-dashes (no traffic yet). Other five nav items navigate
# without errors. Forecast shows a brief "loading chart bundle…" before
# the lazy chunk lands.

# Seed traffic to verify all screens have data (see c3 handoff for the
# full script).
```

If anything 4xxs or the UI shows raw stack traces, the build is stale — re-run `npm run web:build`.

---

## Stop-and-check-in triggers — full carry-forward list

All triggers from c1, c2, c3 handoffs apply. Highest-priority for c4:

- **Phase 4.0 (active):** before exposing any write operation, settle the management-auth posture. Don't ship (a) "localhost trust" by default; the security narrative clashes.
- **Phase 4.0 (active):** before displaying matched-bytes ANYWHERE in Shadow AI or audit detail, STOP. Phase 3.6 invariant.
- **Phase 4.0 (active):** before adding an editor to the Policy screen, design the apply-and-reload story.
- **Phase 4.0 (active):** before changing the Shadow AI grouping axis from detector to token/machine, reread c3 decision 3.
- **Phase 4.0 (active):** before adding another chart-heavy screen, follow the lazy-loading pattern.

Full list in the per-commit handoffs.

---

## Useful commands

```sh
npm run web:install              # one-time
npm run web:build                # main 182 KB / forecast lazy 378 KB
npm run web:dev                  # vite dev server with HMR
npm run serve                    # broker on :7843; /ui has 6 working screens
npx vitest run                   # 472 tests, ~40s
npm run typecheck                # broker
cd web && npm run typecheck      # web
```

---

## Final state

- `origin/main` at `8dbbb26`, three commits ahead of where the session started (`f41186b`).
- 472 tests pass, both typechecks clean.
- Phase 4.0 read-only: **DONE.** Six screens real and wired to live data.
- Phase 4.0 write ops: **PENDING management-auth decision.** The user picks (a), (b), or (c) before c4 starts.
- `Prototype.html` retained until c4 parity.
- 3.x roadmap: still complete. 3.2 c4 dispatcher work still unsmoked.

Take your time.
