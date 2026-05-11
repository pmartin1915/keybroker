# Handoff — keybroker Phase 4.0 completion + post-4.0 roadmap

You are the next instance, on **Opus 4.7** (1M context). The user
wants to stay on Opus for the driving role and **delegate
Sonnet-grade work to subagents**. This handoff lays out the
remaining work in the order I'd ship it, with explicit notes on
what stays on Opus and what gets delegated.

**State at handoff:** `origin/main` at `7369afa`. Phase 4.0 c4d
multi-select revoke shipped + pushed. 497 tests, both typechecks
clean. Four `/ui` write surfaces live: Issue, Revoke (single),
Rotate, Revoke (bulk).

---

## Read these first (in order)

1. `HANDOFF-2026-05-11-phase-4-0-c4d-pushed.md` — the most recent
   per-session handoff.
2. `memory/MEMORY.md` — start-here index + 8 phase-decision pointers.
3. `memory/decision_phase_4_0_commit_4.md` — Management JWT
   invariants (load-bearing for c4e: the admin audit log MUST log
   the mgmt JWT actor, not the proxy token id).

---

## The plan, in order

### c4e — Admin audit log  *(NEXT)*

**Why first:** the Phase 4.0 wedge is "operate the broker from a
browser." Four write surfaces are live but the operator has no
record of who/what/when. Without c4e, the wedge is "you can change
things" but not "you can see what changed." Closes the most obvious
remaining gap.

**Schema decision — done. Use a new `admin_audit` table.** I
considered extending `calls` and rejected it:

- `calls` is hot-path. Every proxy request inserts a row. Admin
  actions are rare. Mixing them means every admin-feed query has
  to filter on `admin_action IS NOT NULL`.
- `calls` has 19 columns tightly fit to telemetry (`req_bytes`,
  `duration_ms`, `estimated_cost_usd`, `requested_model`, …). An
  admin action has none of those and needs different columns
  (`actor_token_id`, `target_token_id`, `action`, `params_json`).
  Forcing both into one table means most columns are NULL for
  whichever row type is sampled.
- Lifecycle differs: `calls` retention will eventually need
  pruning; audit retention is "keep forever for compliance."

**Schema sketch (Opus must finalize before delegating):**

```sql
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                     -- ISO 8601 UTC
  actor_token_id TEXT NOT NULL,         -- brkm_… mgmt JWT id (NOT brk_…)
  actor_label TEXT,                     -- mgmt JWT label at issue time
  action TEXT NOT NULL,                 -- 'token.issue' | 'token.revoke' | 'token.rotate' | 'token.rotateMatch'
  target_token_id TEXT,                 -- the brk_… id this acted on (NULL for batch)
  target_count INTEGER,                 -- for rotate-match / future bulk ops
  params_json TEXT,                     -- compact JSON; filters for rotate, tags for issue
  outcome TEXT NOT NULL,                -- 'ok' | 'failed'
  reason TEXT,                          -- error message if outcome=failed
  source_ip TEXT,                       -- loopback typically; future-proofs for non-loopback writes
  user_agent TEXT                       -- 'web/c4d' | 'cli' | other
);
CREATE INDEX IF NOT EXISTS admin_audit_ts_idx ON admin_audit(ts);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit(actor_token_id);
```

**Load-bearing invariants for c4e** *(Opus owns these — do NOT
delegate the decisions, only the implementation)*:

1. **Actor is the mgmt JWT id, NEVER the target token id.** The
   audit log answers "who did this" — confusing the two defeats
   the read-vs-act separation Option B was built for.
2. **`params_json` is a *summary*, not the request body.** For
   rotate-match: just the filters object (`{team:"x"}`). For issue:
   the tags + cap, not the resulting JWT. Never log token bytes,
   secrets, or anything that could re-mint a token.
3. **Failed writes get logged too.** If revoke fails, the attempt
   is still worth recording. `outcome:'failed'` + `reason`.
4. **The audit write is best-effort.** If the audit insert fails,
   the admin action still succeeds. Audit failures log to stderr
   but never 500 the API call. (Future: a hardened mode could fail
   closed, but not for the wedge story.)
5. **No retroactive audit.** c4-c4d admin actions were never logged
   and never will be. c4e is forward-looking from the migration
   onward.

**Server work (~250 LoC, delegate to Sonnet once invariants locked):**

- Add table to `src/store-sqlite.ts` schema block.
- Add `recordAdminAction(...)` method to `StoreLike` (interface in
  `src/store-types.ts`).
- Implement on both `SqliteStore` and `JsonStore` (the JSON store
  needs an `adminAudit` array — match the existing `calls` pattern).
- New `GET /admin/audit` endpoint in `src/server.ts`, mgmt-JWT
  gated like the other `/admin/*` routes. Pagination params:
  `?limit=200&beforeId=N`. Default sort: `ts DESC`.
- Call `recordAdminAction` from the existing handlers in
  `src/server.ts`: `POST /admin/tokens`, `DELETE /admin/tokens/:id`,
  `POST /admin/tokens/rotate`, `POST /admin/tokens/rotate-match`.
- Tests in `tests/admin-routes.test.ts`: assert that each admin
  action emits an audit row with the right `action`, that failures
  emit `outcome:'failed'`, and that the actor is the mgmt JWT id.

**UI work (~80 LoC, delegate to Sonnet):**

- Extend `web/src/api/client.ts` with `fetchAdminAudit(opts)` +
  `AdminAuditRow` type.
- Add a "Admin" tab to the Audit screen (existing five-outcome
  filter pills become "Calls" filter; new "Admin actions" tab
  shows audit rows). Or: a separate top-level screen "Admin log"
  — Opus picks based on Audit screen layout (read it first).
- Row format: `ts · actor_label (brkm_…) · action · target ·
  outcome` with `params_json` in a collapsed expander.

**Smoke:** mint a mgmt JWT, hit Issue + Revoke + Rotate from /ui,
then load the admin log and confirm three rows with the right
actor.

---

### c4f — Recovery Checklist  *(after c4e)*

**Why second:** this is the **last prototype-vs-broker delta.**
After c4f ships, `Prototype.html` can be retired and Phase 4.0 is
genuinely complete.

**This is a design conversation, not an implementation task.** Opus
must run it. The user has to weigh in on the trigger model. Do not
delegate this to a Sonnet subagent.

**Design questions for Opus to drive:**

1. **What triggers a checklist?** Three candidates, not mutually
   exclusive:
   - **Manual:** "Open incident" button on dashboard. User picks a
     reason and the checklist is created blank.
   - **Auto on revoke:** when N tokens are revoked within window
     T, auto-create a checklist with the affected tokens pre-filled.
   - **Auto on scanner hit:** when the scanner blocks a request
     with detector severity ≥ threshold, auto-create.
   My lean: **all three from day one, but only "manual" wired up
   in c4f.** The data model must support auto-create even if only
   the manual path ships first.

2. **What's *in* a checklist?** Look at `Prototype.html`'s
   reference design. The likely shape:
   - Header: incident id, opened-by, opened-at, status (open/closed).
   - Affected tokens: a list with per-row state (revoked? rotated?
     replaced?).
   - Action steps: a checklist of operator tasks
     (notify on-call / rotate downstream credentials / file
     post-mortem / etc.). Some pre-filled by the trigger type.
   - Notes: free-form markdown.

3. **Schema shape:** new `incidents` table + `incident_tokens`
   junction. Probably extends the audit log too (closing an incident
   is itself an admin action worth recording).

4. **Lifecycle:** incidents don't auto-close; an operator marks
   them closed. Closed incidents stay queryable.

**Opus owns:** the data model, the trigger semantics, the wedge
story ("when do operators actually open this thing?"), the UX flow
between Tokens screen and a checklist.

**Delegate to Sonnet (once design locked):**
- The schema migration.
- The CRUD routes (`GET /admin/incidents`, `POST /admin/incidents`,
  `PATCH /admin/incidents/:id`, etc.).
- The React components for the checklist itself.
- Tests for each route.

---

### Phase 4.0 closeout  *(after c4f)*

- Smoke c4e + c4f against a real-ish deployment (loopback is fine).
- Retire `Prototype.html` — move to `docs/archive/` or delete.
  Verify nothing in the build links to it.
- Final Phase 4.0 handoff documenting the complete wedge story.
- Tag `v0.4.0` if the project does release tags.

**This is light work but should not be skipped.** A retired
prototype prevents future instances from confusedly diffing against
stale reference UI.

---

### Phase 3.2 c4 dispatcher smoke  *(orthogonal, overdue)*

Independent of Phase 4.x. Has been pending since Phase 3.2 commit 4.

**What:** verify `KEYBROKER_ROUTE=1` actually routes gemini +
mistral SDK calls through the broker end-to-end with real API keys.

**Why it's important:** the dispatcher fall-through-to-SDK behavior
is documented as deliberate, but the routed path has never been
exercised with real upstream keys. If there's a bug it's been
silently hidden by the fall-through for months.

**Why it's overdue:** every additional commit on top of an unsmoked
foundation is a commit you can't fully trust.

**Subagent shape:** pure verification, no design. Opus can run this
directly or delegate to Sonnet — either works. Needs real API keys
from the user. **Do not proceed without explicit user
authorization to use their real keys.**

---

### After 4.0 is closed out — the fork

Two viable directions. Pick with the user; don't choose
unilaterally.

**Phase 4.1 — TUI variant (Ink + Yoga).**
- Same data layer, different shape. Status-bar driven, keyboard-first.
- Audience: operators who live in tmux and don't want to alt-tab.
- Larger lift than any individual Phase 4.0 commit. Probably 4-6
  commits.
- **Opus drives the architecture** (component boundaries, focus
  model, key-binding scheme). Sonnet implements individual screens
  once the shape is locked.

**Phase 4.2 — Scanner Layer 2/3.**
- Research wedge. New differentiator (current scanner is Layer 1:
  detector-name regex over request body).
- Layer 2: structured analysis — JSON paths, base64-encoded
  payloads, multipart fragments.
- Layer 3: model-graded — small upstream model evaluates ambiguous
  matches.
- The deep-research prompt has been drafted; this is a research
  session before implementation.
- **Opus owns the research synthesis.** Could delegate the
  research-document drafting to Sonnet, but the synthesis ("what
  do we actually build first?") must be Opus.

My lean: **TUI before scanner Layer 2/3.** TUI deepens the existing
wedge story; scanner Layer 2/3 opens a new wedge. Existing wedge
should be load-bearing before new wedges go in. But this is genuinely
a user-preference call.

---

## Subagent delegation strategy

**Opus owns:**
- Schema decisions ("new table vs extend existing").
- Cross-cutting refactors touching 5+ files.
- Design conversations (trigger semantics, wedge stories, UX flow).
- Invariant-setting commits (anything that establishes a load-bearing
  pattern future instances will mirror).
- Synthesis of research / multi-source comparison.
- Any commit that requires holding the c4 Management-JWT invariants
  in head (memory/decision_phase_4_0_commit_4.md, 13 invariants).

**Delegate to Sonnet 4.6 (via Agent subagent_type general-purpose
or test-runner / reviewer where applicable):**
- Schema migrations once Opus has decided the columns.
- CRUD route implementations once Opus has designed the API shape.
- React components once Opus has picked the affordances.
- Test writing for established patterns (the test files in
  `tests/admin-routes.test.ts` are good templates).
- Mechanical typecheck-error chases.

**Brief Sonnet subagents like this** (paraphrased example for c4e):

> Implement `recordAdminAction` on `SqliteStore` and `JsonStore`.
> Schema is in HANDOFF-2026-05-11-phase-4-completion-plan.md section
> c4e. JSON store mirrors the `calls` array pattern. Add tests to
> tests/admin-routes.test.ts that assert each of POST /admin/tokens,
> DELETE /admin/tokens/:id, POST /admin/tokens/rotate, POST
> /admin/tokens/rotate-match emits an audit row with the right
> action and actor_token_id. Do NOT modify the schema beyond the
> sketch — if you think a column should be added or removed, stop
> and ask Opus.

Note the explicit "stop and ask Opus" clause — that's how Opus stays
in the driver's seat on invariants.

**Do NOT delegate:**
- The "new table vs extend calls" decision *(done above, but the
  pattern matters for c4f and beyond)*.
- The Recovery Checklist trigger conversation.
- The Phase 4.1 vs 4.2 fork.
- Anything where the prompt would have to say "use your judgment
  on X" — judgment calls stay on Opus.

---

## Constraints carried forward (all phases)

- **Mgmt JWT is brkm_, never brk_.** Don't confuse the two.
- **One-time JWT reveal on issue paths.** Never log token bytes.
- **noModelsClaim warning is surfaced, never suppressed.** Phase
  3.8 decision 3.
- **Sequential, not parallel, on bulk operations.** Preserves audit
  ordering. (Now matters more once c4e ships — parallel writes
  would scramble the audit feed.)
- **Read-only endpoints stay loopback-trust; writes require mgmt
  JWT.** Phase 4.0 c1 + c4 architecture.
- **`Prototype.html` is the reference for UI parity until c4f
  ships.** Then retire.

All Stop-and-check-in triggers from c1 / c2 / c3 / c4 / c4c / c4d
carry forward.

---

## Useful commands (unchanged across phases)

```sh
npm run web:install                       # one-time
npm run web:build                         # main 217 KB / forecast 378 KB
npm run web:dev                           # vite HMR
npm run serve                             # broker on :7843

keybroker token mgmt --issue --label dashboard --ttl 28800  # 8h mgmt JWT

npx vitest run                            # 497 tests, ~40s
npm run typecheck                         # broker
cd web && npm run typecheck               # web
```

If `npx vitest run` reports beforeAll-hook timeouts on first run,
re-run once. Documented in `trap_test_subprocess_flake_windows.md`.

---

## Final state at this handoff

- `origin/main` at `7369afa`.
- Working tree clean.
- 497 tests pass, both typechecks clean.
- Phase 4.0 wedge: **Issue + Revoke (single) + Rotate + Revoke
  (bulk) all live.** Audit log + Recovery Checklist remaining.
- 3.x roadmap complete; 3.2 c4 dispatcher unsmoked.
- This handoff is the master plan. Per-commit handoffs continue to
  be written as work ships.

Take your time. Pick c4e first.
