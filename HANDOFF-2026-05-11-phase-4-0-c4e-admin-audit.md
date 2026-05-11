# Handoff — keybroker Phase 4.0 c4e admin audit log (2026-05-11)

You are the next instance. **Phase 4.0 c4e — admin audit log — is
shipped and pushed.** Every /admin/* write (issue, revoke, rotate)
now emits an `admin_audit` row with the mgmt JWT actor, target, and
params summary. The Audit screen has a new `Admin actions` tab.

Working tree clean. `origin/main` at `1a46419`.

This closes the most obvious Phase 4.0 wedge gap — four write
surfaces were live without an operator-facing view of who/what/when.
**One remaining prototype-vs-broker delta:** the Recovery Checklist
(c4f). Once that ships, `Prototype.html` retires and Phase 4.0 is
fully complete.

---

## Commit this session

| Commit | Phase | What |
|---|---|---|
| `1a46419` | 4.0 c4e | New `admin_audit` table + best-effort `recordAdminAction`; `requireManage` stashes `mgmtTokenLabel`; wired into POST /admin/tokens, DELETE /admin/tokens/:id, POST /admin/tokens/rotate (real-run only); new GET /admin/audit endpoint; UI tab toggle on AuditScreen with admin-row table + detail panel. 8 invariants locked in `memory/decision_phase_4_0_commit_4e.md`. |

Driving model: Opus 4.7. Server implementation delegated to a Sonnet
4.6 subagent against the invariants in the decision file; UI
extension delegated to a second Sonnet 4.6 subagent. Opus owned the
decision file and reviewed both diffs.

**Tests:** 497 → 508 (+11 new admin-audit tests in
`tests/admin-routes.test.ts`).
**Bundle:** main `217 → 224 KB` (`62 → 62.48 KB gz`). +7 / +0.5.

---

## What's real at `/ui` now

```
http://127.0.0.1:7843/ui/
├─ Dashboard       (c1)
├─ Tokens          (c2 + c4 + c4c + c4d)  table + Issue + Revoke + Rotate + Bulk-Revoke
├─ Audit           (c2 + c4e)  Calls tab (default) + Admin actions tab
├─ Forecast        (c3)
├─ Policy          (c3)  read-only
└─ Shadow AI       (c3)
```

**The full /admin/* write surface is now audited:**
- `POST /admin/tokens` → emits `token.issue` (ok or failed).
- `DELETE /admin/tokens/:id` → emits `token.revoke` (ok including
  already-revoked; failed on unknown id or race-404).
- `POST /admin/tokens/rotate` real-run → emits `token.rotate` (ok
  with `targetCount` or failed `no_filters`). **Preview and dryRun
  do NOT audit** (invariant 6 — don't pollute the feed with
  blast-radius exploration).

**Still NOT live:**
- Policy editing.
- Recovery Checklist screen — prototype only; needs backend design.
- `Prototype.html` retained until c4f.

---

## c4e invariants (load-bearing)

See `memory/decision_phase_4_0_commit_4e.md` for the full 8. The
load-bearing ones for any future change in this area:

1. **Three actions only:** `token.issue`, `token.revoke`,
   `token.rotate`. Adding a fourth (e.g. `incident.open` for c4f) is
   a deliberate decision.
2. **Actor is the `brkm_…` mgmt JWT id, NEVER the `brk_…` target.**
   The hook stashes both `mgmtTokenId` and `mgmtTokenLabel`.
3. **`paramsJson` is a summary, NEVER the request body.** No JWT, no
   ciphertext, no secret bytes. Same posture as Phase 3.6 scanner
   reason field.
4. **Audit write is best-effort.** `recordAdminAction` MUST NOT
   throw. A failed audit must not 500 the API call.
5. **Failed admin actions audit too** (with `outcome: "failed"`).
6. **Preview/dryRun rotate do NOT audit.** Only the real run does.
   `no_filters` 400 is the documented exception (it's a malformed
   attempt, not exploration).
7. **No retroactive audit.** Actions from c4 / c4b / c4c / c4d
   sessions are gone forever — c4e is forward-looking only.
8. **JsonStore audit lives in a sibling JSONL file** at
   `join(dirname(logsPath), "admin-audit.jsonl")`. Mirrors the
   `calls` pattern.

---

## Smoke recipe (verifies c4e end-to-end)

```sh
# 1. Build + serve.
npm run web:build
npm run serve     # broker on 127.0.0.1:7843

# 2. Mint a mgmt JWT.
TOKEN=$(keybroker token mgmt --issue --label smoke-c4e --ttl 3600)

# 3. Verify gate.
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7843/admin/audit
# → 401 (no_management_token)

curl -s http://127.0.0.1:7843/admin/audit \
  -H "authorization: Bearer $TOKEN" | head -200
# → {"rows":[]} (or whatever exists; for a fresh DB it's empty)

# 4. Exercise the three write surfaces.
curl -s -X POST http://127.0.0.1:7843/admin/tokens \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"provider":"echo","label":"smoke-1","ttlSeconds":3600,"tags":{"team":"smoke"}}'
# → 201, returns {tokenId, jwt, record}

# Capture the tokenId for revoke + rotate.
TID=<tokenId from previous response>

curl -s -X DELETE http://127.0.0.1:7843/admin/tokens/$TID \
  -H "authorization: Bearer $TOKEN"
# → 200, {revoked: true, id}

curl -s -X POST http://127.0.0.1:7843/admin/tokens/rotate \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"filters":{"team":"smoke"}}'
# → 200, may report revoked: 0 since the only smoke token is already revoked

# 5. Read the audit feed.
curl -s http://127.0.0.1:7843/admin/audit?limit=10 \
  -H "authorization: Bearer $TOKEN" | head -200
# → at least token.issue (ok) + token.revoke (ok) + token.rotate (ok with targetCount:0)

# 6. UI: visit http://127.0.0.1:7843/ui/ → Audit → click "Admin actions" tab.
#    Modal prompt asks for mgmt JWT; paste $TOKEN.
#    Verify the three rows appear with the right actor label
#    (smoke-c4e), action, and outcome.

# 7. Verify invariant 3 with a paramsJson assertion:
curl -s "http://127.0.0.1:7843/admin/audit?limit=1" \
  -H "authorization: Bearer $TOKEN" | grep -c '"jwt"'
# → 0 (paramsJson must NEVER contain the resulting JWT bytes).
```

---

## Reasonable next moves

- **Phase 4.0 c4f — Recovery Checklist (NEXT).** The last
  prototype-vs-broker delta. **Design conversation, not pure
  implementation** — see the master plan
  (`HANDOFF-2026-05-11-phase-4-completion-plan.md`) section c4f for
  the trigger model + schema discussion Opus must drive with the
  user. Don't delegate this to Sonnet without the user weighing in
  on the data model and trigger semantics.

- **Phase 4.0 closeout.** After c4f, retire `Prototype.html`, write
  the final Phase 4.0 handoff, tag if appropriate. Light work but
  shouldn't be skipped (a retired prototype prevents future
  instances from diffing against stale reference UI).

- **Phase 3.2 c4 dispatcher smoke** — still pending, orthogonal to
  Phase 4.x. Needs real gemini + mistral API keys with explicit user
  authorization to use them.

- **Phase 4.1 (TUI) vs 4.2 (scanner Layer 2/3) fork** — pick with
  the user after 4.0 closes. Lean: TUI first (deepens the existing
  wedge); scanner Layer 2/3 opens a new wedge. Genuinely a
  user-preference call.

---

## Stop-and-check-in triggers — c4e-specific

- Before adding admin-audit retention/pruning, STOP. Current posture
  is "keep forever for compliance." A retention policy needs a
  conversation about who decides the cutoff.
- Before extending `paramsJson` with new fields, STOP and reread
  invariant 3. If the new field could re-mint a token or expose
  secret bytes, it doesn't belong there.
- Before audit-logging preview/dryRun rotate, STOP. Invariant 6 is
  load-bearing: blast-radius exploration must not pollute the feed.
- Before parallelizing bulk-revoke in the UI, STOP (c4d trigger
  carries forward). Sequential DELETEs preserve audit-row ordering
  in the feed — parallel would scramble it.

All triggers from c1 / c2 / c3 / c4 / c4c / c4d carry forward.

---

## Subagent delegation notes from this session

Both implementation halves (server, UI) were delegated to Sonnet 4.6
subagents while Opus 4.7 stayed in the driver's seat for the
decisions. Pattern that worked:

1. **Lock invariants in the memory file FIRST.** Both subagent briefs
   pointed at `memory/decision_phase_4_0_commit_4e.md` as the
   canonical contract. This kept the work coherent across two
   independent Sonnet contexts.
2. **Include "STOP and ask Opus" clauses in the briefs.** Neither
   subagent triggered one this session, which is the goal — clear
   contracts mean no judgment calls escape Opus.
3. **Trust but verify the diff, not the summary.** Each subagent
   reported success; Opus then read the actual diff to confirm
   `paramsJson` never carries the JWT, `recordAdminAction` doesn't
   throw, preview/dryRun don't audit, etc. The Opus review took
   ~3-5 minutes per subagent.
4. **Don't merge the server and UI into one subagent task.** Two
   contexts kept each prompt focused and the file scope tight. The
   server subagent never touched `web/`; the UI subagent never
   touched `src/`.

Repeatable for c4f. The Recovery Checklist design itself stays on
Opus, but once the schema + trigger semantics are locked, the CRUD
routes + React shell can both delegate.

---

## Useful commands

```sh
npm run web:install                       # one-time
npm run web:build                         # main 224 KB / forecast lazy 378 KB
npm run web:dev                           # vite dev with HMR
npm run serve                             # broker on :7843; /ui has admin audit tab

keybroker token mgmt --issue --label dashboard --ttl 28800  # 8h mgmt JWT

npx vitest run                            # 508 tests, ~40s
npm run typecheck                         # broker (clean)
cd web && npm run typecheck               # web (clean)
```

If `npx vitest run` reports beforeAll-hook timeouts on first run,
re-run once. Documented in `trap_test_subprocess_flake_windows.md`.

---

## Final state

- `origin/main` at `1a46419` (this commit) + whatever the handoff
  commit hash becomes.
- 508 tests pass, both typechecks clean.
- Phase 4.0 wedge: **Issue + Revoke (single) + Rotate + Revoke
  (bulk) + Admin audit all live**. Recovery Checklist is the last
  prototype-vs-broker delta.
- 3.x roadmap complete; 3.2 c4 dispatcher unsmoked.
- `Prototype.html` retained until c4f.

Take your time. Pick c4f next, and run the design conversation with
the user before delegating any implementation.
