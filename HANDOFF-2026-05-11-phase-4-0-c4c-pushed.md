# Handoff — keybroker Phase 4.0 c4c pushed (2026-05-11)

You are the next instance. **Phase 4.0 c4c — Rotate-all UI — is
shipped and pushed.** Tokens screen now has all three Phase 4.0
write affordances: Issue, Revoke, Rotate matched.

Working tree clean. `origin/main` at `6adeed3`.

The conversation worth pausing for: **what's the next surface?**
The prototype-vs-broker delta is now down to the Recovery Checklist
(no backend), an admin audit log (mostly server work), or different
direction entirely (TUI, scanner Layer 2/3, dispatcher smoke).

---

## Commit this session

| Commit | Phase | What |
|---|---|---|
| `6adeed3` | 4.0 c4c | Rotate-all UI. New `RotateTokensModal.tsx` (four-step state machine). `TokensScreen` gets a `Rotate matched…` button next to Issue, plus `kind:"rotate"` in the PendingAction union for auth resume. |

Per-commit detail: `HANDOFF-2026-05-11-phase-4-0-commit-4c.md`.
Read it first if you're going to touch the rotate modal or the
header layout.

**Tests:** 497 unchanged. **Bundle:** main 195 → **210 KB / 60 KB gz**
(+15 / +3). Forecast lazy chunk unchanged.

---

## What's real at `/ui` now

```
http://127.0.0.1:7843/ui/
├─ Dashboard       (c1)  stat cards, tag-rollup, machine-spend list
├─ Tokens          (c2 + c4 + c4c)  table + Issue + Revoke + Rotate
├─ Audit           (c2)  five-outcome filter pills
├─ Forecast        (c3)  breach countdown + burn leaders + tag burn
├─ Policy          (c3)  structured display (read-only)
└─ Shadow AI       (c3)  detector-name buckets
```

**Write operations live:**
- `+ Issue token` header button (c4b).
- Two-step `Revoke / Confirm revoke` in token detail panel (c4b).
- `Rotate matched…` header button → four-step blast-radius modal (c4c).

**Still NOT live:**
- Policy editing. Read-only is deliberate; needs apply/reload story.
- Multi-select revoke on the Tokens table.
- Recovery Checklist screen — prototype only; no backend.
- Admin audit log. /admin/* writes aren't surfaced to operators.

---

## Reasonable next phases

- **Phase 4.0 c4d — Recovery Checklist.** Design the data model
  first (new table or extend `calls`? what triggers checklist
  creation — a revoke event, a manual "open incident", a scanner
  hit?). The UI is the easy part; the backend semantics are the
  conversation. Prototype.html has a reference design.
- **Admin audit log on server.** New `admin_audit` table or extend
  `calls` with an `admin_action` outcome. Mirrors the `recentCalls`
  shape and lets the dashboard surface "who issued/revoked/rotated
  what". Probably 200-300 LoC server + 50 LoC UI for the Audit screen.
- **Multi-select revoke on Tokens table.** Smaller win; needs a
  checkbox column and a confirm-modal with the same posture as
  single-revoke. Three-step ceremony is overkill here; one confirm
  is enough.
- **Phase 4.1 — TUI variant** (Ink + Yoga). Status bar + same data
  layer. Larger lift but a different shape.
- **Phase 4.2 prep — scanner Layer 2/3.** Deep research prompt
  exists; this is a research session, not an implementation.
- **Phase 3.2 c4 dispatcher smoke.** Still unsmoked since 3.2.
  `KEYBROKER_ROUTE=1` with real gemini + mistral keys.
- **Hold.** Three write surfaces live and pushed is a complete
  wedge. Smoke-test against a real deployment before adding more.

---

## Smoke test (verifies c4c specifically)

```sh
# 1. Build + serve.
npm run web:build
npm run serve   # broker on :7843, in another terminal

# 2. Mgmt token (once per tab).
TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)

# 3. Two test tokens to rotate against.
keybroker token issue --provider echo --label rota --tag-team rotteam
keybroker token issue --provider echo --label rotb --tag-team rotteam

# 4. http://127.0.0.1:7843/ui/ → Tokens → "Rotate matched…"
# 5. Mgmt prompt → paste $TOKEN → Save.
# 6. team=rotteam → Preview impact.
# 7. total=2, byTeam{rotteam:2} → Show reissue plan.
# 8. Two-row plan, "ok" notes → Execute → Confirm.
# 9. Result panel shows two brk_ JWTs → Copy each → Done.
# 10. Tokens table now shows rota/rotb REVOKED plus two new active
#     rows with the same labels (the new ids).
```

If you want to exercise the lossy-warning path, you need a pre-3.8
token (no `models` column) — fresh installs won't produce one.
The dry-run plan column shows `ok` for normal use.

---

## Stop-and-check-in triggers — c4c-specific (additive to c4 / c1-c3)

- Before adding a "Repeat with same filters" affordance to step 4,
  STOP. The four-step ceremony is the point.
- Before persisting the rotate filter set to sessionStorage or URL,
  STOP. Operators must consciously re-type.
- Before adding any `noModelsClaim` "I understand, suppress this"
  affordance, STOP. Phase 3.8 decision 3 is non-negotiable.
- Before adding a rotate variant that bypasses dry-run (e.g. "Quick
  rotate by machine"), STOP. Per-token consequences must be visible.

All triggers from c1 / c2 / c3 / c4 carry forward.

---

## Useful commands

```sh
npm run web:install                       # one-time
npm run web:build                         # main 210 KB / forecast lazy 378 KB
npm run web:dev                           # vite dev with HMR
npm run serve                             # broker on :7843; /ui has rotate-all

keybroker token mgmt --issue --label dashboard --ttl 28800  # 8h mgmt JWT

npx vitest run                            # 497 tests, ~40s
npx vitest run tests/admin-routes.test.ts # 25 tests
npm run typecheck                         # broker (clean)
cd web && npm run typecheck               # web (clean)
```

If `npx vitest run` reports beforeAll-hook timeouts on first run,
re-run once. Documented in `trap_test_subprocess_flake_windows.md`.

---

## Final state

- `origin/main` at `6adeed3`, one commit ahead of where the session
  started (`188291c`).
- 497 tests pass, both typechecks clean.
- Phase 4.0 wedge: **Issue + Revoke + Rotate live**. Recovery
  Checklist still on the design board. Policy still read-only.
- 3.x roadmap complete; 3.2 c4 dispatcher unsmoked.
- `Prototype.html` retained until Recovery Checklist reaches parity.

Take your time.
