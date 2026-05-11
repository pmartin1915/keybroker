# Handoff — keybroker Phase 4.0 c4c (rotate-all UI) — 2026-05-11

You are the next instance. Phase 4.0 c4c ships the **rotate-all UI**
on the Tokens screen. The admin route (`POST /admin/tokens/rotate`)
was already in place since c4a — this commit only adds the frontend
three-step blast-radius flow.

This handoff is the per-commit detail. The c4 meta-handoff
(`HANDOFF-2026-05-11-phase-4-0-c4-pushed.md`) is the entry point.

---

## What shipped

**New file:** `web/src/components/RotateTokensModal.tsx` (~600 LoC).

Four-state modal driven by an internal `step` variable
(`"filter" | "preview" | "dryRun" | "result"`). Every transition is an
explicit operator click; nothing auto-advances. Each step makes a
separate admin-fetch — stale data is fine because the operator
re-runs the prior step from "← Back".

**Touched:** `web/src/components/TokensScreen.tsx`. Added:
- `import RotateTokensModal` and a `rotateOpen` state slot.
- `PendingAction` discriminated-union extended with `{ kind: "rotate" }`.
- `openRotate` opener, `onRotateAuthNeeded` handler, `onAuthConfirmed`
  resume branch for rotate.
- A `Rotate matched…` button next to `+ Issue token` in the header.

**Bundle:** main 195 → **210 KB / 60 KB gz** (+15 / +3). Forecast lazy
chunk unchanged.

**Tests:** 497 unchanged. The pure-UI change has no broker-side test
seam; the admin-routes suite already exercises preview / dryRun /
real-run shapes (`tests/admin-routes.test.ts:338-430`).

---

## The four steps in detail

### Step 1 — filter (`FilterForm`)

Five inputs: team / project / env / machine / provider. The Build
function trims and drops empty strings. Submit gates on `Object.keys(f)
.length === 0` and shows the error message inline — mirrors the
server's `no_filters` 400 (Phase 3.8 decision 1). Defence-in-depth:
if a future refactor breaks the client gate, the server still rejects.

### Step 2 — preview (`PreviewPanel`)

`RotatePreview` data:
- `total` huge number, dimmed if zero.
- `FiltersEcho` pills so the operator can verify the query.
- Four `Breakdown` cards (byMachine / byTeam / byProject / byEnv).
  Each card shows up to the top 5 entries by count + an "… +N more"
  hint.
- `Show reissue plan →` button is disabled when total = 0.

### Step 3 — dryRun (`DryRunPanel`)

`RotateDryRun` data, scrollable up to `maxHeight: 360`:
- Warning banner counting `noModelsClaim` records (warning colour,
  loud — this is the only signal pre-3.8 records will lose their
  model restriction; Phase 3.8 decision 3 says **never suppress**).
- 4-column grid: Label / Old id / New id / `lossy` or `ok` chip.
- Expired-skip line below (up to 4 labels + count overflow).
- Two-step confirm: `Execute rotation` swaps to `Cancel /
  Confirm execute` with a sentence describing the action and count.
- `Execute rotation` is disabled if `plan.length === 0` (all matched
  tokens were expired).

### Step 4 — result (`ResultPanel`)

`RotateResult` data:
- Header sentence: "Revoked N and reissued M. Skipped K expired."
- Scrollable grid of `ReissuedRow` cards, each with:
  - Label + old→new id + `lossy` badge if applicable
  - Per-row Copy button
  - The full JWT shown in mono, `user-select: all`, scrollable
- `Copy all (JSON)` button serializes
  `[{label, oldId, newId, jwt, noModelsClaim}, …]` to clipboard.
- Footer reminder: "Closing this view permanently loses the new JWT bytes."

---

## Load-bearing decisions

1. **No auto-advance.** Each step requires an explicit click. The
   c4 stop-trigger explicitly forbids "skip the confirm" affordances.
   This is enforced by separate buttons, not a checkbox the operator
   could disable.

2. **Filter gate is BOTH client and server.** The server already
   returns 400 `no_filters` (verified in admin-routes.test.ts:339-351).
   The client also blocks empty submission with an inline message
   so the operator gets fast feedback. Both layers stay.

3. **`noModelsClaim` is surfaced THREE TIMES.** Once as a count in
   the dry-run warning banner, once as a per-row chip in the dry-run
   plan, once as a per-row badge in the result reveal. Phase 3.8
   decision 3 invariant: "Do NOT suppress the lossy warning."

4. **JWTs are never persisted in the dashboard.** The result panel
   is the only place the new bytes are ever shown. There is no
   "show again later" affordance, no localStorage key, no recovery
   route. This mirrors `IssueTokenModal`'s one-time-reveal posture
   (Phase 4.0 c4 decision 7-ish).

5. **"Back" navigation works `dryRun → preview → filter` but not
   from result.** Going back loses the previously-fetched data
   (preview / dry-run), forcing a re-fetch on the next forward step.
   This matters because the underlying token set may have changed
   while the modal was open.

6. **Auth resume path is symmetric with Issue/Revoke.** A 401 at any
   network call throws `MgmtAuthError`, which the modal forwards to
   `onNeedsAuth`. `TokensScreen.onAuthConfirmed` reopens the modal
   from step 1 with empty filters (not the previous filter set) —
   intentional, so a stale auth path doesn't silently re-submit a
   dangerous query.

7. **`Rotate matched…` button uses the secondary (outline) style;
   `+ Issue token` uses the primary (accent) style.** Issue is the
   day-to-day operation; rotate is the fire-drill operation. Visual
   weight tracks frequency-of-use, not destructiveness.

---

## Smoke test (full c4 chain)

```sh
# Build
npm run web:build
npm run serve   # broker on :7843 in another terminal

# Mint a mgmt token
TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)

# Issue two tokens to rotate against, both tagged team=rotteam.
keybroker token issue --provider echo --label rota --tag-team rotteam
keybroker token issue --provider echo --label rotb --tag-team rotteam

# Open http://127.0.0.1:7843/ui/#/tokens
# (it's tab-based, not hash-routed yet — click Tokens in the sidebar)

# 1. Click "Rotate matched…"
# 2. First-time mgmt prompt fires → paste $TOKEN → Save.
# 3. Filter form opens; enter team=rotteam → Preview impact.
# 4. Step 2 shows total=2, byTeam=rotteam:2 → Show reissue plan.
# 5. Step 3 lists two rows old→new ids → Execute rotation → Confirm.
# 6. Step 4 reveals two JWTs starting brk_ → Copy each → Done.
# 7. Tokens table refreshes; both rota/rotb now appear as REVOKED
#    plus two new active rows with the same labels.
```

To verify the lossy warning, you'd need a pre-3.8 token (without a
`models` column). New-issue tokens won't trigger it. The dry-run
plan column will say `ok` in normal use.

---

## Stop-and-check-in triggers (rotate-specific, additive to c4)

- Before adding a "Repeat with same filters" affordance to step 4,
  STOP. The four-step ceremony is the point. A repeat button skips
  three of those steps and recreates the footgun.
- Before persisting the rotate filter set to sessionStorage / URL
  for "convenience", STOP. The previous filter set should NOT
  survive a modal close — operators must consciously re-type it.
- Before adding a `noModelsClaim` "I understand, suppress this
  warning" checkbox, STOP. Phase 3.8 decision 3 is non-negotiable.
- Before adding any rotate variant that bypasses the dry-run step
  (e.g. "Quick rotate by machine"), STOP. The dry-run was added to
  the CLI in Phase 3.8 specifically because preview-only didn't
  show per-token consequences.

All c4-level triggers (one-time JWT reveal, sessionStorage-only mgmt
token, two-step confirm on revoke) carry forward unchanged.

---

## What c4c does NOT include

- **No bulk Copy-all-as-CSV** — clipboard payload is JSON only.
  CSV adds parsing surface; if an operator wants CSV they can pipe
  the JSON through jq.
- **No per-row Re-issue affordance** for the expired list. The
  expired-skip is reported but the operator must re-issue manually
  via the Issue modal — that's the right shape because expired
  tokens may have stale claims that need review before reissue.
- **No "rotate this one token" affordance** in the per-token detail
  panel. Single-token rotation is a different primitive (revoke +
  manually re-issue with the same claims). Keep the rotate primitive
  bulk-only, matching the CLI.
- **No deep-link** — the modal is invoked via button click only.
  URL-routable modals are a bigger refactor (the dashboard isn't
  hash-routed; tab state lives in `App.tsx` useState).

---

## Carry-forward

- `Prototype.html` still retained. With c4c, the bundled dashboard
  now covers Issue / Revoke / Rotate — the only missing surface vs.
  the prototype is the Recovery Checklist (which has no backend yet).
- The Tokens screen header is getting crowded (search + filter pills
  + Rotate + Issue). A "+ Bulk actions" overflow menu may be worth
  considering before adding more affordances (e.g. multi-select
  revoke from a future c4d).
- Server-side admin audit log is still unaddressed. /admin/* writes
  including rotate are not logged anywhere visible to an operator.
- Phase 3.2 c4 dispatcher routing still unsmoked.

---

## Final state

- Working tree clean before commit.
- 497 tests pass (one re-run needed for the Windows port-binding flake;
  trap memory note `trap_test_subprocess_flake_windows.md` carries the
  context).
- Both typechecks clean.
- Bundle: main 210 KB / 60 KB gz; Forecast lazy chunk 378 KB unchanged.

Phase 4.0 wedge after c4c: **Issue + Revoke + Rotate live** on /ui.
Recovery Checklist is the remaining prototype-vs-broker delta.
