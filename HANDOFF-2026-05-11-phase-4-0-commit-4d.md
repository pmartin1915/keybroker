# Handoff — keybroker Phase 4.0 c4d (multi-select revoke)

You are the next instance. **Phase 4.0 c4d — Multi-select revoke on
the Tokens table — is implemented and ready to commit.** The Tokens
screen now has the four write affordances the Phase 4.0 wedge wants:
Issue, Revoke (single), Rotate, Revoke (bulk).

## What changed

| File | Change |
|---|---|
| `web/src/components/BulkRevokeModal.tsx` | New. ~270 LoC. Three-phase modal: `list → confirming → done`. Sequential `DELETE /admin/tokens/:id` per selected row with per-row outcome badges (REVOKED / ALREADY REVOKED / FAILED / queued). Mid-batch `MgmtAuthError` abandons the rest of the batch and re-prompts. |
| `web/src/components/TokensScreen.tsx` | Selection state (`Set<string>` of ids). Checkbox column added to header + rows (revoked rows render a blank spacer, not a disabled input). "Select all visible" header checkbox. "Revoke N selected…" outline-danger button + "clear" link appear in the header cluster when selection > 0. `PendingAction` gains `kind: "bulkRevoke"`. |

## Numbers

- **Bundle:** main `210 → 217 KB / 60 → 62 KB gz` (+7 / +1 KB gz).
  Forecast lazy chunk unchanged.
- **Tests:** 497 unchanged (UI-only commit).
- **Typechecks:** broker + web both clean.

## Design invariants (full detail in `memory/decision_phase_4_0_commit_4d.md`)

1. **Revoked rows are not selectable** — blank spacer, not disabled
   input. Selecting a revoked token is a server-side no-op but adds
   noise to the bulk modal's count.
2. **Selection persists across filter changes** — `Set<string>`
   keyed on id. Filter to "revoked" to inspect; selection stays
   intact.
3. **Three-click ceremony, matches single-revoke** — select rows →
   click "Revoke N selected…" → click "Yes, revoke N".
4. **Mid-batch auth failure abandons the rest** — partial state is
   refreshed back to the parent (`onExecuted`), then auth prompt
   resumes. Re-opening shows already-revoked rows with their final
   outcome.

## Stop-and-check-in triggers (additive to c1/c2/c3/c4/c4c)

- Before adding a "Select all matching filter" affordance that
  crosses into pagination, STOP. The table doesn't paginate; a
  10k-row select-all would sequentially fire 10k DELETEs.
- Before parallelizing the DELETE loop, STOP. Sequential preserves
  audit ordering on the `calls` table; concurrent writes change
  observable behavior on the Audit screen.
- Before adding a "Skip confirm" / "Quick revoke" affordance to a
  bulk operation, STOP. Single-revoke and rotate both require
  multi-step confirmation; bulk-revoke needs at least as much.

## Smoke test

```sh
npm run web:build
npm run serve

TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)

# 1. Mint a handful of test tokens.
for i in 1 2 3 4 5; do
  keybroker token issue --provider echo --label "bulk$i" --tag-team bulkteam
done

# 2. http://127.0.0.1:7843/ui/ → Tokens.
# 3. Mgmt prompt → paste $TOKEN → Save (if not already set).
# 4. Check the boxes next to bulk1, bulk3, bulk5.
# 5. Header shows "Revoke 3 selected…"; click it.
# 6. Modal lists three rows, all "queued". Click "Revoke 3 tokens…".
# 7. Confirm panel appears. Click "Yes, revoke 3".
# 8. Each row transitions to REVOKED. Footer shows "Revoke complete · revoked 3 · already-revoked 0 · failed 0".
# 9. Click Done. Table refreshes. bulk1/3/5 now show REVOKED; bulk2/4 still active.
# 10. Select-all-visible checkbox in header should select bulk2+bulk4 only (revoked rows skipped).
```

## What's still NOT live

- Policy editing (read-only by design — needs apply/reload story).
- Recovery Checklist screen — prototype only; no backend.
- Admin audit log — `/admin/*` writes happen but aren't surfaced
  to operators as a separate audit feed.

## Reasonable next phases

- **Admin audit log.** New `admin_audit` table or extend `calls`
  with an `admin_action` outcome. Mirrors `recentCalls`. ~200-300
  LoC server + 50 LoC UI. Now the more obvious gap given c4d ships.
- **Recovery Checklist (c4e).** Still needs backend design — what
  triggers checklist creation: revoke event, manual incident,
  scanner hit? Prototype.html has the reference UI.
- **Phase 4.1 — TUI variant.** Ink + Yoga, status-bar style. Larger
  lift, different shape.
- **Phase 3.2 c4 dispatcher smoke.** `KEYBROKER_ROUTE=1` with real
  gemini + mistral keys.
- **Hold.** Four write surfaces live is a complete-enough wedge.
  Smoke-test on a real deployment before adding more.

## Final state

- Working tree at handoff time: 2 new files (BulkRevokeModal.tsx,
  this handoff) + 1 modified (TokensScreen.tsx).
- Memory: `decision_phase_4_0_commit_4d.md` written, MEMORY.md
  start-here updated.
- `origin/main` was at `0b19aeb` when this session started.
