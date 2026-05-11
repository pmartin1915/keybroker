# Handoff — keybroker Phase 4.0 commit 4 (issue + revoke) (2026-05-11)

You are the next instance. **Phase 4.0 c4 is live in two commits.** The
management-auth gating decision from the c1/read-only handoffs is
settled: **Option B (Management JWT)** is what shipped. Two commits
landed this session:

- **c4a** (`17a0378`) — server-side: keychain entry, mint/verify, CLI
  subcommand, three admin routes, 25 tests.
- **c4b** (`b4cb599`) — frontend: admin client, mgmt-token modal,
  Issue Token form, Revoke confirm in token detail.

`origin/main` is at `8dbbb26`; the two new commits are local and ahead
of origin. **Push when you're ready** — nothing controversial in either
diff and tests pass.

The wedge story is *almost* complete on the write axis. The two
remaining gaps:

1. **Rotate-all UX** — admin route exists (covered by c4a tests),
   but the prototype's three-step blast-radius UI (preview → dry-run
   → execute, showing each new JWT) isn't wired yet.
2. **Recovery Checklist screen** — the prototype demonstrates this;
   no backend equivalent yet. Design before implementing.

`Prototype.html` is still retained pending those two.

---

## What landed (c4a — server-side)

| Layer | File | Change |
|---|---|---|
| Keychain | `src/keychain.ts` | New `KC_MGMT_SECRET = "mgmt_secret"` constant. Separate from `KC_JWT_SECRET` so the proxy axis and the write axis have independent blast radii. |
| Config | `src/config.ts` | `BrokerConfig.mgmtSecret` (required field). `loadConfig` lazy-creates a fresh secret on first call if absent — existing installs upgrade transparently. `init` generates it upfront for new installs and prints all three keychain accounts. |
| JWT primitives | `src/tokens.ts` | `issueManagementToken` / `verifyManagementToken` with `brkm_` prefix and `keybroker-mgmt` issuer. `scope: "manage"` claim is fixed (forward-compat for a future split into read-only vs rotate). Refuses to mint with non-positive TTL — admin tokens MUST expire. |
| CLI | `src/cli.ts` | New `keybroker token mgmt --issue --label <name> --ttl <seconds>` subcommand. Default TTL 8h; output is the bare JWT on stdout so it pipes. |
| Issue helper | `src/issue.ts` (new) | `issueTokenFlow` — shared validation + persist + mint, returning `{ok: true, tokenId, jwt, record}` or `{ok: false, error, hint?}`. Used by the admin route. *Note: CLI's `token issue` was NOT refactored to use it — its per-flag error messages are user-friendly and not worth changing this commit. Future consolidation work.* |
| Admin routes | `src/server.ts` | Three new routes, all gated by an `onRequest` pre-handler that verifies the mgmt JWT via `verifyManagementToken`: `POST /admin/tokens` (issue), `DELETE /admin/tokens/:id` (revoke; idempotent), `POST /admin/tokens/rotate` (preview / dryRun / real-run). Mgmt-token extraction has its own helper (`extractPresentedManagementToken`) that enforces the `brkm_` prefix — a `brk_` proxy token presented at /admin/* is rejected at the prefix guard, before signature verification touches the wrong secret. |
| Tests | `tests/admin-routes.test.ts` (new, 25 tests) | mint/verify round-trip, prefix invariants (proxy JWT → `missing_prefix`), auth gating on every admin route (missing / wrong-prefix / tampered → 401), POST /admin/tokens shape + tag/cap persistence, DELETE idempotency + unknown-id 404, rotate preview/dryRun/real-run with claim preservation (cap + models). |
| Test config | 7 test files | All `BrokerConfig` literals updated to carry `mgmtSecret`. |

**Tests:** 472 → **497** (+25). Both typechecks clean.

---

## What landed (c4b — frontend)

| Layer | File | Change |
|---|---|---|
| API client | `web/src/api/client.ts` | Admin surface: `issueProxyToken`, `revokeProxyToken`, `rotatePreview` / `rotateDryRun` / `rotateExecute`. Mgmt-token storage: `getMgmtToken` / `setMgmtToken` / `clearMgmtToken` (sessionStorage; `brkm_` prefix guard on read). `MgmtAuthError` thrown when no token cached or 401 from broker — cache is cleared on 401 so the next call re-prompts. `probeMgmtToken` validates without mutating (POST rotate with empty filters expects 400 `no_filters`). |
| Mgmt prompt | `web/src/components/MgmtTokenModal.tsx` (new) | Paste textarea, `brkm_` prefix check, probe-then-save flow. The CLI command (`keybroker token mgmt --issue --label dashboard`) is shown verbatim so first-time operators know where the token comes from. The token never leaves the page except via the outbound Authorization header. |
| Issue UI | `web/src/components/IssueTokenModal.tsx` (new) | Form: provider, label, TTL (hours), cap (USD), team, project, env, models (comma-separated). On success, surfaces the JWT in a one-time copy-paste reveal panel — closing/refreshing loses it. Clipboard API copy button with 2s "Copied ✓" feedback. The JWT is never re-fetched; never logged. |
| Tokens screen | `web/src/components/TokensScreen.tsx` | "+ Issue token" button in header. Revoke affordance in the per-token detail panel — two-step confirm (first click → red-tinted "Confirm revoke"). Auth flow: any `MgmtAuthError` → opens `MgmtTokenModal` with the broker's `reason` → re-runs the original pending action (issue or revoke) after confirm. `refreshTick` state forces an immediate `/tokens` reload after writes so the table reflects new state without waiting on the 15s poll. |
| App shell | `web/src/App.tsx` | Nav footer reads "c4 issue + revoke live". "Coming next" updated to flag the still-pending Rotate-all UX. |

**Bundle:** main 182 → 195 KB / 54 → 57 KB gz (+13 / +3). Forecast lazy chunk unchanged.

---

## Decisions locked in (don't re-litigate)

1. **Separate signing secret for management JWTs.** Distinct from the proxy `jwtSecret`. Even compromising the proxy axis does not let an attacker mint admin tokens. Rotating one secret never invalidates the other. The two secrets live in separate keychain accounts (`jwt_secret`, `mgmt_secret`).
2. **`brkm_` prefix on management JWTs.** Visually distinguishes them from `brk_` proxy tokens on the wire. The admin-route token extractor *requires* the `brkm_` prefix — a `brk_` token presented to `/admin/*` is rejected before signature verification, on top of the separate-secret defence.
3. **Different JWT issuer (`keybroker-mgmt` vs `keybroker`).** Even on the off chance an operator reused secrets across keychain entries, the issuer mismatch fails verify. Defence-in-depth.
4. **Management tokens MUST expire.** `issueManagementToken` refuses to mint with `ttlSeconds ≤ 0`. A misplaced sessionStorage entry doesn't grant forever; the CLI defaults to 8h.
5. **Lazy-create the mgmt secret on first `loadConfig()`.** Existing installs (pre-c4) don't have to re-run `init`. The secret is generated and stored on first access; subsequent loads find it cached. Fresh installs get it via `init` upfront.
6. **`issueTokenFlow` factored into `src/issue.ts`, but only the admin route uses it.** The CLI's per-flag error messages ("invalid --cap-usd value: …") are user-friendly and tied to specific flags; rewriting them as generic `invalid_cap_usd` strings is a regression. The shared helper is the new canonical path; CLI consolidation is a future cleanup, not a c4 task.
7. **Idempotent DELETE /admin/tokens/:id.** Revoking an already-revoked token returns 200 with `alreadyRevoked: true`. 404 is reserved for "never existed". The dashboard can retry safely.
8. **Rotate-all over HTTP keeps the no-filter guardrail.** Same posture as the CLI (Phase 3.8 decision): zero filters → 400 `no_filters`. Full-fleet rotation in one keystroke remains intentionally not supported.
9. **POST /admin/tokens/rotate (real run) returns the new JWTs inline.** The CLI prints them on stdout one per line; the route returns `{revoked, reissued: [{oldId, newId, label, jwt, noModelsClaim}], expired}`. The dashboard surfaces them in the rotate UI when it lands — for now the API is correct and ready.
10. **sessionStorage, NOT localStorage, for the management token.** Closing the tab drops it; short blast radius if a session is left open on a shared machine. The token is never persisted to localStorage and never logged.
11. **`probeMgmtToken` validates without side effects.** Posts to `/admin/tokens/rotate` with `{filters: {}}` — broker rejects with 400 `no_filters` when auth passes. No tokens issued, no audit pollution. A 401 means the token is bad.
12. **Two-step confirm on revoke.** First click swaps the button to a danger-tinted "Confirm revoke" with the token label inlined. Bulk revoke / rotate get their own dedicated confirm flows when wired.
13. **One-time JWT reveal on issue.** Refreshing the modal or closing it loses the value. The dashboard never re-fetches the JWT and never persists it. Operators copy it before dismissing or re-issue.

---

## What's NOT real yet (intentional)

- **Rotate-all UI.** Admin route ships; UI defers. The prototype's three-step blast-radius preview is non-trivial: filter form → preview counts → dry-run plan → execute → list of new JWTs. Each step needs its own confirm gate. Carving it into its own commit keeps c4 reviewable.
- **Recovery Checklist screen.** No backend equivalent yet. Design the data model first (incident → checklist items → resolution timestamps) before adding the UI.
- **Bulk operations on the Tokens table.** No "select multiple → revoke" affordance. The detail-panel revoke is the per-token path; rotate-all covers the bulk path once its UI lands.
- **Admin call audit trail.** Today, /admin/* writes have no dedicated audit log (the proxy `/calls` log only records token *usage*, not issue/revoke/rotate). Future schema bump could add an `admin_audit` table.
- **`Prototype.html` deletion.** Retained until rotate-all UI + Recovery Checklist reach parity.

---

## Reasonable next moves

### Option A — c4c: Rotate-all UI (the next obvious thing)

The admin route works (c4a tests cover preview / dryRun / real-run). The
UI is the missing surface.

Sketch:
1. "Rotate matched" button on Tokens screen (or per-tag drill-down).
2. Filter form modal (team / project / env / machine / provider).
3. Step 1: call `rotatePreview` — show counts (`byMachine`, `byTeam`,
   etc.). Operator confirms blast radius.
4. Step 2: call `rotateDryRun` — show the plan (old-id → new-id list,
   `noModelsClaim` warnings, expired-skip list). Operator confirms claim
   preservation.
5. Step 3: call `rotateExecute` — show the new JWTs in a copy-paste
   grid (one per row). Same one-time-reveal posture as issue.
6. Auth flow inherits from c4b: any 401 → MgmtTokenModal → resume.

### Option B — c4d: Recovery Checklist screen

Needs backend design first. A `recovery_checklist` table or a JSON file?
Items are created on what event? The prototype's UX is the design target;
read it before building the data model.

### Option C — Server-side admin audit log

Today an operator can't tell *who* issued / revoked which token over
HTTP. A dedicated `admin_audit` table (mgmt token id, action, target,
timestamp, body summary) would close the gap. Mirrors the existing
`recentCalls` shape.

### Option D — Hold here

c4a + c4b is a complete and shippable wedge of write functionality.
Holding lets you smoke-test the issue/revoke flow against a real
deployment before adding more surface.

---

## Smoke test the next instance can run

```sh
# 1. Build + serve (in two terminals).
npm run web:install   # if not done
npm run web:build
npm run serve

# 2. Mint a management token.
TOKEN=$(keybroker token mgmt --issue --label smoke --ttl 3600)
echo "$TOKEN"   # starts with brkm_

# 3. Open the UI.
open http://127.0.0.1:7843/ui/
# Navigate to Tokens. Click "+ Issue token".

# 4. First click should pop the MgmtTokenModal. Paste $TOKEN, click
#    "Save & continue". Modal closes; Issue form opens.

# 5. Fill in provider=echo, label=smoke-via-ui, ttl=24, click Issue.
#    The form swaps to a one-time JWT reveal. Copy it. Click Done.

# 6. Table refreshes; new row appears.

# 7. Click the new row → detail panel. Click "Revoke token", then
#    "Confirm revoke". Row goes red; status REVOKED.

# 8. Sanity: refresh the browser. Click Issue again — the modal
#    should NOT prompt for the management token (sessionStorage
#    survives reload).

# 9. Close the tab, reopen. Click Issue — modal SHOULD prompt
#    again (sessionStorage is per-tab).
```

If the first Issue-button click goes directly to the form (no auth
prompt), the broker has accepted a token from a previous session —
expected, since the CLI / `init` keeps the secret across runs.

---

## Stop-and-check-in triggers — new in c4

All triggers from c1 / c2 / c3 carry forward (the management-auth one
is now closed — Option B shipped). New for c4:

- **Phase 4.0 (active):** before rendering the minted JWT anywhere
  outside the IssueTokenModal's one-time reveal, STOP. The
  one-time-reveal posture is load-bearing — the dashboard never
  persists or re-fetches token bytes.
- **Phase 4.0 (active):** before persisting the management token to
  localStorage (or anywhere outside sessionStorage), STOP. The
  short-blast-radius posture is deliberate.
- **Phase 4.0 (active):** before adding a "skip the confirm" flag to
  revoke or rotate, STOP. The two-step posture is deliberate.
- **Phase 4.0 (active):** before allowing zero-filter rotate over HTTP,
  reread Phase 3.8 decision 1. The route already rejects this; if you
  find yourself "fixing" it, STOP.
- **Phase 4.0 (active):** before factoring the CLI's `token issue` to
  call `issueTokenFlow`, audit every per-flag error message. The CLI's
  current strings are tied to specific flags; replacing them with
  generic codes is a regression.
- **Phase 4.0 (active):** before adding a separate "admin_audit" log,
  decide whether it lives in the existing calls table (with a new
  outcome `admin_action`) or its own table. The current code logs
  *nothing* for admin actions — that's a known gap.

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

- Two new commits ahead of `origin/main` (which is still at `8dbbb26`
  in this handoff's frame of reference — push when ready):
  - `17a0378` Phase 4.0 c4a — management JWT + admin routes (server).
  - `b4cb599` Phase 4.0 c4b — Issue + Revoke UI (frontend).
- 497 tests pass (was 472 → +25 from c4a). Both typechecks clean.
- Phase 4.0 wedge: **issue + revoke now real**, rotate-all UI deferred,
  Recovery Checklist still on the design board.
- 3.x roadmap: still complete. 3.2 c4 dispatcher work still unsmoked.

Take your time.
