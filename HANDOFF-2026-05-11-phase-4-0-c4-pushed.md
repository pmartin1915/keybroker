# Handoff — keybroker Phase 4.0 c4 pushed (2026-05-11)

You are the next instance. **Phase 4.0 c4 — Issue + Revoke — is shipped
and pushed.** The management-auth question that gated all write
operations is settled: **Option B (Management JWT)** is what shipped.

Working tree clean. `origin/main` at `8f5e3e3`.

The conversation worth pausing for: **rotate-all UI**. The admin route
exists and is covered by tests; the prototype's three-step blast-radius
flow is the next obvious UI commit. Or: pick a different direction. Both
are defensible from here.

---

## Commit chain pushed this session

| Commit | Phase | What |
|---|---|---|
| `17a0378` | 4.0 c4a | Server-side. `KC_MGMT_SECRET` keychain entry (lazy-created for pre-c4 installs). `issueManagementToken` / `verifyManagementToken` with `brkm_` prefix and separate `keybroker-mgmt` issuer. `keybroker token mgmt --issue` CLI subcommand. Three admin routes (`POST/DELETE /admin/tokens`, `POST /admin/tokens/rotate`) gated by an `onRequest` pre-handler. Shared `issueTokenFlow` in `src/issue.ts`. +25 tests. |
| `b4cb599` | 4.0 c4b | Frontend. Admin client (`issueProxyToken`, `revokeProxyToken`, rotate triplet, sessionStorage helpers, `MgmtAuthError`, `probeMgmtToken`). `MgmtTokenModal` (paste + validate + cache). `IssueTokenModal` (form + one-time JWT reveal). "+ Issue token" button and two-step Revoke flow on Tokens screen. |
| `8f5e3e3` | 4.0 c4 docs | Per-commit handoff for c4 — the long one with 13 locked-in decisions, smoke script, and stop-and-check-in triggers. |

**Tests:** 472 at session start → **497 now (+25)**. Both typechecks clean.

**Bundle:** main 182 → **195 KB / 57 KB gz** (+13 / +3). Forecast lazy chunk unchanged.

---

## Read this for full context

`HANDOFF-2026-05-11-phase-4-0-commit-4.md` — the per-commit handoff
bundled with `8f5e3e3`. Has the 13 decisions in detail, file-by-file
breakdown, smoke-test script, and the full carry-forward list. **Read
it first if you're going to touch /admin/\* or the dashboard write
surface.** Everything below is the meta-pointer.

---

## What's real at `/ui` now

```
http://127.0.0.1:7843/ui/
├─ Dashboard      (c1) stat cards, tag-rollup, machine-spend list
├─ Tokens         (c2 + c4) filterable table + Issue + Revoke
├─ Audit          (c2) five-outcome filter pills
├─ Forecast       (c3) breach countdown + burn leaders + tag burn
├─ Policy         (c3) structured display (read-only)
└─ Shadow AI      (c3) detector-name buckets
```

**Write operations live:**
- "+ Issue token" header button on Tokens.
- Two-step "Revoke / Confirm revoke" in the per-token detail panel.
- Management-token paste modal pops on first attempt; cached in
  sessionStorage; cleared on 401.

**Write operations NOT live yet (intentional):**
- Rotate-all UI. Admin route ships and tests pass; UI defers.
- Policy editing. Read-only is deliberate; needs an apply/reload story.
- Bulk operations on the Tokens table (multi-select revoke).

---

## The pending UI surface — rotate-all (the next obvious thing)

The admin route is `POST /admin/tokens/rotate` and supports three
modes via the request body:

- `{filters, preview: true}` → counts only (`{total, byMachine,
  byTeam, byProject, byEnv}`).
- `{filters, dryRun: true}` → planned reissue list (`[{oldId, newId,
  label, noModelsClaim}]`) + expired-skip list.
- `{filters}` → real run. Returns the new JWTs inline:
  `{revoked, reissued: [{oldId, newId, label, jwt, noModelsClaim}],
  expired}`.

The client functions are already exported from `web/src/api/client.ts`:
`rotatePreview`, `rotateDryRun`, `rotateExecute`. No backend work
needed — only UI.

Sketch:
1. "Rotate matched" button on Tokens (or a tag drill-down chip).
2. Filter form modal — team / project / env / machine / provider.
3. Step 1: `rotatePreview` → show blast-radius counts. Operator confirms.
4. Step 2: `rotateDryRun` → show the plan. Highlight `noModelsClaim`
   warnings (pre-3.8 records). Show expired-skip list. Confirm.
5. Step 3: `rotateExecute` → grid of new JWTs, one per row, with
   per-row Copy buttons. Same one-time-reveal posture as Issue.
6. Auth flow inherits from c4b: any 401 → `MgmtTokenModal` → resume.

---

## Other reasonable next phases (if rotate UI is deferred)

- **Phase 4.0 c4d — Recovery Checklist screen.** The prototype
  demonstrates this; the broker has no backend equivalent. Design the
  data model first (table or JSON? what triggers checklist creation?)
  before adding the UI.
- **Server-side admin audit log.** Today /admin/* writes are not
  logged anywhere — an operator can't tell who issued/revoked which
  token over HTTP. New `admin_audit` table or extend `calls` with an
  outcome like `admin_action`. Mirror the existing `recentCalls` shape.
- **Phase 4.1 — TUI variant** (Ink + Yoga). Status bar pinned (spend,
  active tokens, current machine). Data layer is ready.
- **Phase 4.2 prep — scanner Layer 2/3 deep research.** TruffleHog +
  Presidio architecture. Prompt drafted in `Claude-Deep-Research-Prompt.md`.
- **Phase 3.2 c4 smoke** — the dispatcher's broker-routing change was
  never smoked. `KEYBROKER_ROUTE` defaults off; flipping default-on
  needs verification against gemini + mistral with real keys.
- **Hold.** c4a + c4b is a complete shippable wedge of write
  functionality. Holding lets you smoke-test against a real deployment
  before adding more surface.

---

## Smoke test (verifies the pushed state)

```sh
# 1. Build + serve.
npm run web:install   # if not done
npm run web:build
npm run serve         # broker on :7843, in another terminal

# 2. Mint a management token (the new CLI subcommand).
TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)
echo "$TOKEN"   # starts with brkm_

# 3. Open http://127.0.0.1:7843/ui/ → Tokens → "+ Issue token".
# 4. First click pops the MgmtTokenModal. Paste $TOKEN, Save & continue.
# 5. Issue form opens. provider=echo, label=smoke, ttl=24 → Issue.
# 6. One-time JWT reveal. Copy. Done.
# 7. Table refreshes. Click the new row → Revoke → Confirm revoke.
#    Row goes red, status REVOKED.
# 8. Refresh browser. Issue again — NO mgmt prompt (sessionStorage).
# 9. Close tab, reopen — mgmt prompt fires again (per-tab storage).
```

If the first Issue-button click skips the auth prompt, the broker has
accepted a token from a previous session — that's fine and expected
since the keychain entry is persistent.

---

## Stop-and-check-in triggers — c4-specific (full list in `HANDOFF-2026-05-11-phase-4-0-commit-4.md`)

- Before rendering a freshly-minted JWT anywhere outside the
  IssueTokenModal one-time reveal, STOP. The dashboard never persists
  or re-fetches token bytes.
- Before persisting the management token to localStorage (or anywhere
  outside sessionStorage), STOP. The short-blast-radius posture is
  deliberate.
- Before adding "skip the confirm" to revoke or rotate, STOP.
- Before allowing zero-filter rotate over HTTP, reread Phase 3.8
  decision 1 (the route already rejects this).
- Before refactoring CLI's `token issue` to call `issueTokenFlow`,
  audit every per-flag error message — the current strings are tied
  to specific flags and replacing them with generic codes is a UX
  regression.
- Before deleting `Prototype.html`, confirm rotate UI + Recovery
  Checklist have reached parity.

All triggers from c1 / c2 / c3 carry forward. The c1 management-auth
trigger is now closed.

---

## Useful commands

```sh
npm run web:install                    # one-time
npm run web:build                      # main 195 KB / forecast lazy 378 KB
npm run web:dev                        # vite dev server with HMR
npm run serve                          # broker on :7843; /ui has issue+revoke

keybroker token mgmt --issue --label dashboard --ttl 28800   # 8h mgmt JWT
keybroker token mgmt --issue --label ci --ttl 3600           # short-lived

npx vitest run                         # 497 tests, ~55s
npx vitest run tests/admin-routes.test.ts   # 25 tests, ~25s
npm run typecheck                      # broker (clean)
cd web && npm run typecheck            # web (clean)
```

---

## Final state

- `origin/main` at `8f5e3e3`, three commits ahead of where the session
  started (`b5abaef`).
- 497 tests pass, both typechecks clean.
- Phase 4.0 wedge: **issue + revoke real**, rotate-all UI deferred,
  Recovery Checklist still on the design board.
- 3.x roadmap: still complete. 3.2 c4 dispatcher work still unsmoked.
- `Prototype.html` retained until rotate UI + Recovery Checklist
  reach parity.

Take your time.
