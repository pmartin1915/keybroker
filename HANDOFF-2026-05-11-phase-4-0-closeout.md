# Handoff — keybroker Phase 4.0 closeout (2026-05-11)

You are the next instance. **Phase 4.0 is closed out.** The bundled
`/ui` dashboard covers every operator surface the Phase 4.0 wedge
called for. `Prototype.html` is retired to `docs/archive/`. There is
no c4f.

Working tree clean (modulo this commit). `origin/main` at `d29bb20`
before commit; new commit on top will move HEAD forward by one.

---

## The c4f reframing

The previous master plan (`HANDOFF-2026-05-11-phase-4-completion-plan.md`)
described c4f as a "Recovery Checklist" port of the prototype's
`RecoveryModal`. On inspection, that scope didn't survive contact with
our actual rotate-all primitive.

**The finding:**

- `Prototype.html:583-588`'s `rotateAll` is **revoke-only**. After it
  flips tokens to revoked, it opens `RecoveryModal` for the operator
  to mint replacements as a separate step. The recovery modal exists
  *to compensate for* the prototype's split rotate flow.
- The broker's `POST /admin/tokens/rotate` (Phase 3.8, wired through
  c4c) is **revoke + reissue atomic**. `buildReissueArgs(rec, newId)`
  runs inside the same transaction. After rotate-all completes, every
  matched token already has a fresh replacement with cloned claims.

The two-step recovery flow and the one-step atomic rotate are
equivalent end-states reached by different paths. The prototype's
recovery modal addresses a gap that our broker doesn't have. Porting
it would be either a no-op (chain reissue from rotate-all → nothing
to reissue) or a *new* feature (chain reissue from single/bulk-revoke,
or standalone reissue on Tokens screen). Neither is parity work.

**Decision (user, this session):** declare Phase 4.0 done. Retire
the prototype. Move on. If post-4.0 operator demand surfaces for
"compromise-revoke → fresh replacement" as a workflow, ship it as a
post-4.0 feature with explicit justification — not bundled into
closeout.

---

## What landed across Phase 4.0

| Commit | Sub-phase | What |
|---|---|---|
| Phase 4.0 c1 | scaffold | `web/` peer package, Vite + React + TS, `/ui` static mount before catch-all, no-auth read endpoints, no router/state-lib yet. 7 architecture choices locked in `memory/decision_phase_4_0_commit_1.md`. |
| Phase 4.0 c2 | screens | Tokens table + Audit table reading `/admin/tokens` + `/admin/calls`. Five-outcome filter pills on Audit. |
| Phase 4.0 c3 | analytics | Forecast (Recharts, lazy-loaded), Policy (read-only), Shadow AI (groups by detector name). Decisions in `HANDOFF-2026-05-11-phase-4-0-commit-3.md`. |
| Phase 4.0 c4a | mgmt auth | Management JWT (Option B) — separate signing secret, `brkm_` prefix, separate issuer, sessionStorage-only on web, one-time reveal on `keybroker token mgmt --issue`. 13 invariants in `memory/decision_phase_4_0_commit_4.md`. |
| Phase 4.0 c4b | write UI #1 | Issue + Revoke (single) from Tokens screen. |
| Phase 4.0 c4c | write UI #2 | Rotate-all four-step ceremony (preview → filters confirm → dry-run → execute). `noModelsClaim` surfaced 3x. 5 invariants in `memory/decision_phase_4_0_commit_4c.md`. |
| Phase 4.0 c4d | write UI #3 | Multi-select revoke. Checkbox column, sequential DELETE loop preserves audit order, persistent selection across filters. 4 invariants in `memory/decision_phase_4_0_commit_4d.md`. |
| Phase 4.0 c4e | audit log | New `admin_audit` table, `recordAdminAction` best-effort, `GET /admin/audit` cursor-paginated, Audit screen Calls/Admin tab toggle. 8 invariants in `memory/decision_phase_4_0_commit_4e.md`. |
| Phase 4.0 closeout | retire | `Prototype.html` → `docs/archive/`. This handoff. |

**Final tree at closeout:**

```
http://127.0.0.1:7843/ui/
├─ Dashboard
├─ Tokens          table + Issue + Revoke + Rotate + Bulk-Revoke
├─ Audit           Calls tab + Admin actions tab
├─ Forecast
├─ Policy          read-only
└─ Shadow AI
```

Tests: 508 passing. Both typechecks clean. Main bundle 224 KB
(62.48 KB gzipped).

---

## Phase 4.0 wedge story (for future reference)

**"Operate the broker from a browser, without giving the dashboard
the right to mint new tokens by accident."**

Two-tier auth was the load-bearing decision:
- Loopback-trust reads (`/admin/tokens`, `/admin/calls`, etc.) —
  anyone on the same machine sees state.
- Mgmt-JWT-gated writes (`POST /admin/tokens`, `DELETE`,
  `POST /rotate`, `GET /admin/audit`) — only an operator holding a
  `brkm_` JWT can mutate or read the audit log.

A leaked `brk_` proxy token cannot become an issue-rights credential.
A leaked `brkm_` JWT is a real incident — it's separately scoped,
separately signed, and surfaced in the audit log with its own
`actor_token_id`.

---

## Carry-forward invariants (still load-bearing, all phases)

- **`brkm_` mgmt JWT and `brk_` proxy token never confused.**
- **One-time JWT reveal on every issue path** (mgmt + proxy + rotate
  + reissue if ever shipped). Never logged.
- **`noModelsClaim` warning surfaced, never suppressed** (Phase 3.8).
- **Sequential, not parallel, on bulk operations** — preserves audit
  ordering. Especially matters now that c4e logs every write.
- **`params_json` in audit is a summary, never carries token bytes
  or JWT** (c4e invariant 3).
- **Preview/dryRun rotate do not audit** (c4e invariant 6) — they're
  blast-radius exploration, not action.
- **Audit write is best-effort** — admin action succeeds even if the
  audit row fails (c4e invariant 4).
- **Loopback-trust reads, mgmt-JWT writes.** Architecture from c1+c4.

All Stop-and-check-in triggers from c1 / c2 / c3 / c4 / c4c / c4d /
c4e carry forward.

---

## Pending: live UI smoke for c4e

`HANDOFF-2026-05-11-phase-4-0-c4e-admin-audit.md` contains the smoke
recipe. The c4e instance couldn't drive a browser, neither could this
one. Recipe is roughly:

```sh
keybroker token mgmt --issue --label dashboard --ttl 28800
# paste the brkm_ JWT into the dashboard's mgmt-token prompt
# Issue one token, revoke one, rotate-all (with a filter), and confirm
# three rows in Audit → Admin actions with the right actor + action +
# target.
```

Run it whenever you have a moment at a machine. Not blocking — the
test suite asserts route correctness; the smoke confirms the UI wires.

---

## Pending: Phase 3.2 c4 dispatcher smoke (overdue, orthogonal)

Independent of Phase 4.x. Has been pending since Phase 3.2 commit 4.

**What:** verify `KEYBROKER_ROUTE=1` actually routes gemini + mistral
SDK calls through the broker end-to-end with real API keys.

**Why important:** the dispatcher fall-through-to-SDK behavior is
documented as deliberate, but the routed path has never been
exercised with real upstream keys. Every Phase 4.x commit on top is
a commit you can't fully trust.

Needs real API keys from the user. **Do not proceed without explicit
user authorization to use their real keys.** Pure verification, no
design — Opus can run it or delegate to Sonnet.

---

## The fork ahead

With Phase 4.0 closed, there are two viable directions. Both
articulated in the previous master plan; the call belongs to the user.

**Phase 4.1 — TUI variant (Ink + Yoga).**
Same data layer, different shape. Status-bar driven, keyboard-first.
Audience: operators in tmux. Probably 4-6 commits. Opus drives the
component/focus/keybinding architecture; Sonnet implements screens
once shape is locked. *Deepens the existing wedge.*

**Phase 4.2 — Scanner Layer 2/3.**
Layer 2: structured analysis (JSON paths, base64, multipart).
Layer 3: model-graded for ambiguous matches. New differentiator on
top of the current Layer 1 detector-name regex (Phase 3.6). Deep-
research prompt is already drafted; this is a research session
before implementation. Opus owns the synthesis. *Opens a new wedge.*

**Previous Opus's lean:** TUI before scanner Layer 2/3 — deepen
existing wedge before opening a new one. Genuinely a user-preference
call.

---

## Subagent delegation pattern that worked

Documented in c4e's handoff and worth carrying forward:

1. **Opus drafts and locks invariants** in a `memory/decision_*.md`
   file. The file becomes the canonical contract.
2. **Briefing format** for Sonnet subagents:
   > "Implement X. Spec is at `memory/decision_*.md` section N. Do
   > NOT modify the schema/shape beyond the spec — if you think a
   > column should be added or removed, **stop and ask Opus**."
3. **Two independent Sonnets in parallel** for server + UI splits
   work well — neither saw the other's diff, both stayed on contract.
4. **Opus reviews both diffs against the invariants** before
   committing. Catches scope creep that the subagents wouldn't.

c4e shipped 12 files / ~700 LoC under this pattern with one Opus
review pass and zero "stop and ask" interruptions. Reproducible.

---

## Useful commands (unchanged)

```sh
npm run web:install                       # one-time
npm run web:build                         # main 224 KB / forecast 378 KB
npm run web:dev                           # vite HMR
npm run serve                             # broker on :7843

keybroker token mgmt --issue --label dashboard --ttl 28800  # 8h mgmt JWT

npx vitest run                            # 508 tests, ~40s
npm run typecheck                         # broker
cd web && npm run typecheck               # web
```

If `npx vitest run` reports beforeAll-hook timeouts on first run,
re-run once. Documented in `trap_test_subprocess_flake_windows.md`.

---

## Final state at this handoff

- `origin/main` at the closeout commit.
- Working tree clean post-commit.
- 508 tests pass, both typechecks clean.
- **Phase 4.0: CLOSED.** Issue + Revoke (single) + Rotate + Revoke
  (bulk) + Admin audit all live + Prototype retired.
- 3.x roadmap complete; 3.2 c4 dispatcher smoke still overdue.
- Next: user picks 4.1 (TUI) vs 4.2 (scanner L2/L3). Or knocks out
  the 3.2 c4 smoke first.

Take your time. There is no c4f.
