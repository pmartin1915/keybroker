# Handoff — keybroker Phase 4.0 c4d pushed (2026-05-11)

You are the next instance. **Phase 4.0 c4d — Multi-select revoke
on the Tokens screen — is shipped and pushed.** The Tokens screen
now has the complete Phase 4.0 write surface: Issue, Revoke (single),
Rotate, Revoke (bulk).

Working tree clean. `origin/main` at `1e46798`.

The conversation worth pausing for: **with the dashboard's write
surface now complete, what's the next priority?** The biggest
remaining wedge gap is now the admin audit log — there's no
operator-facing view of who/what/when across the writes we just
shipped.

---

## Commit this session

| Commit | Phase | What |
|---|---|---|
| `1e46798` | 4.0 c4d | Multi-select revoke on Tokens table. New `BulkRevokeModal.tsx` (three-phase: list → confirming → done). Checkbox column + select-all-visible header. `PendingAction` gains `kind: "bulkRevoke"; tokenIds: string[]`. |

Per-commit detail: `HANDOFF-2026-05-11-phase-4-0-commit-4d.md`.
Read it first if you're going to touch the bulk modal or the
Tokens header layout.

**Tests:** 497 unchanged (UI-only commit).
**Bundle:** main `210 → 217 KB` (`60 → 62 KB` gz). +7 / +1.

---

## What's real at `/ui` now

```
http://127.0.0.1:7843/ui/
├─ Dashboard       (c1)  stat cards, tag-rollup, machine-spend list
├─ Tokens          (c2 + c4 + c4c + c4d)  table + Issue + Revoke (single) + Rotate + Revoke (bulk)
├─ Audit           (c2)  five-outcome filter pills (calls only)
├─ Forecast        (c3)  breach countdown + burn leaders + tag burn
├─ Policy          (c3)  structured display (read-only)
└─ Shadow AI       (c3)  detector-name buckets
```

**Write operations live:**
- `+ Issue token` header button (c4b).
- Two-step revoke in token detail panel (c4b).
- `Rotate matched…` four-step modal (c4c).
- `Revoke N selected…` three-phase bulk modal (c4d). Appears in the
  header when ≥1 active token is checked.

**Still NOT live:**
- Policy editing. Read-only is deliberate; needs apply/reload story.
- Recovery Checklist screen — prototype only; no backend.
- Admin audit log. /admin/* writes happen but aren't surfaced as a
  separate operator feed. **This is now the most obvious gap.**

---

## Reasonable next phases

- **Admin audit log on server (c4e candidate).** New `admin_audit`
  table or extend `calls` with an `admin_action` outcome column.
  Mirrors `recentCalls` shape. Dashboard "who issued/revoked/rotated
  what" + Audit screen tab for admin events. ~200-300 LoC server
  + 50 LoC UI. **Most obvious next gap now that all four write
  surfaces are live.**
- **Phase 4.0 c4f — Recovery Checklist.** Design the data model
  first: what triggers checklist creation — revoke event, manual
  "open incident", scanner hit? UI is easy; backend semantics is
  the conversation. Prototype.html has a reference design.
- **Phase 4.1 — TUI variant** (Ink + Yoga). Status bar + same data
  layer. Larger lift but a different shape.
- **Phase 4.2 prep — scanner Layer 2/3.** Research session, not
  implementation.
- **Phase 3.2 c4 dispatcher smoke.** Still unsmoked since 3.2.
  `KEYBROKER_ROUTE=1` with real gemini + mistral keys.
- **Hold.** Four write surfaces live is a complete wedge. Smoke
  on a real deployment before adding more.

---

## Smoke test (verifies c4d specifically)

```sh
# 1. Build + serve.
npm run web:build
npm run serve

# 2. Mgmt token (once per tab).
TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)

# 3. Five test tokens.
for i in 1 2 3 4 5; do
  keybroker token issue --provider echo --label "bulk$i" --tag-team bulkteam
done

# 4. http://127.0.0.1:7843/ui/ → Tokens.
# 5. Mgmt prompt → paste $TOKEN → Save.
# 6. Check bulk1, bulk3, bulk5. Header shows "Revoke 3 selected…".
# 7. Click it → modal lists three rows, all "queued".
# 8. Click "Revoke 3 tokens…" → confirm panel.
# 9. Click "Yes, revoke 3" → each row transitions to REVOKED.
# 10. Footer: "revoked 3 · already-revoked 0 · failed 0". Click Done.
# 11. Table refreshes: bulk1/3/5 REVOKED, bulk2/4 still active.
# 12. Click header checkbox → only bulk2/bulk4 select (revoked rows skipped).
```

---

## Stop-and-check-in triggers — c4d-specific (additive to c4 / c4c)

- Before adding a "Select all matching filter" affordance that
  crosses into pagination, STOP. The table doesn't paginate; a
  10k-row select-all would sequentially fire 10k DELETEs.
- Before parallelizing the bulk DELETE loop, STOP. Sequential
  preserves audit ordering on `calls` table.
- Before adding "Skip confirm" / "Quick revoke" affordances, STOP.
  Bulk revoke needs at least as much ceremony as single revoke.

All triggers from c1 / c2 / c3 / c4 / c4c carry forward.

---

## Useful commands

```sh
npm run web:install                       # one-time
npm run web:build                         # main 217 KB / forecast lazy 378 KB
npm run web:dev                           # vite dev with HMR
npm run serve                             # broker on :7843; /ui has bulk revoke

keybroker token mgmt --issue --label dashboard --ttl 28800  # 8h mgmt JWT

npx vitest run                            # 497 tests, ~40s
npm run typecheck                         # broker (clean)
cd web && npm run typecheck               # web (clean)
```

If `npx vitest run` reports beforeAll-hook timeouts on first run,
re-run once. Documented in `trap_test_subprocess_flake_windows.md`.

---

## Final state

- `origin/main` at `1e46798`, one commit ahead of the previous
  session start (`0b19aeb`).
- 497 tests pass, both typechecks clean.
- Phase 4.0 wedge: **Issue + Revoke (single) + Rotate + Revoke
  (bulk) all live**. Admin audit log is now the most obvious
  remaining gap. Policy still read-only. Recovery Checklist still
  prototype-only.
- 3.x roadmap complete; 3.2 c4 dispatcher unsmoked.
- `Prototype.html` retained until Recovery Checklist reaches parity.

Take your time.
