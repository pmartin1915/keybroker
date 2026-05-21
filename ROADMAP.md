# Roadmap

> **Current cadence (May 2026):** the project is in a deliberate feature
> freeze pending the outcome of the validation experiment defined in
> `docs/POSITIONING.md`. Pro-tier work (RS256, broker authentication,
> Docker Compose, rate limiting) is blocked until the +7d post-experiment
> decision lands. The "Where we are" section below supersedes the
> phased v0.1 plan reproduced under "Implementation history."

---

## Where we are — 2026-05-21

### Shipped through Phase 4.x

Everything below is in `main` and verified by `npm test` (630 / 630):

- **Phase 1** — production minimums: streaming proxy, SQLite store, master
  key in OS keychain via keytar (file-backed fallback for headless), CI
  on Node 22 / Ubuntu + Windows.
- **Phase 2** — Money Rule features: per-token model allowlists with glob
  matching, dollar spend caps with pre-flight + post-call reconciliation,
  per-machine attribution, fleet policy with hot reload.
- **Phase 3** — dispatcher integration primitives: machine identity
  normalization (`normalizeMachine`), broker routing in `provider.mjs`,
  tag-bucketed spend aggregation, linear-regression burn forecast,
  scanner with decoder layer (base64 / URL / JSON-string-unescape) and
  Layer 2 verification for `github_pat`, `stripe_live_key`, and AWS
  access-key pairs (home-rolled SigV4 STS), per-call TTFT + TPOT latency
  telemetry, rotate-with-TTL.
- **Phase 4.0** — bundled Vite + React web UI at `/ui` with one-time
  management-JWT prompts for write actions and an `admin_audit` log.
- **Phase 4.1** — Ink TUI under `tui/` with fleet-write screens (issue,
  rotate, bulk revoke) and read-only screens (forecast, policy,
  shadow AI).
- **Phase 4.2** — Layer 2 verify shipped (a/b/c): decode-then-scan,
  `github_pat` + `stripe_live_key` upstream calls, AWS STS verifier with
  home-rolled SigV4 (~150 LoC, no `@aws-sdk` dependency).

Operator-onramp polish (May 14–17, post-Phase-4.2c): default port unified
on 7843, asciinema cast isolated via `KEYBROKER_HOME` +
`KEYBROKER_KEYCHAIN_PATH`, README architecture diagram corrected
(`store.db` not `store.sqlite`), `SECURITY.md` added, gitleaks audit
clean, `examples/systemd` and `examples/nginx-front` shipped, README
"Deploying as a daemon" section added.

### The validation experiment (in flight)

Hours 1 and 2 of the 3-hour experiment defined in `docs/POSITIONING.md`
(factual README cleanup + three post drafts at `docs/hour-2-posts.md`)
are **audit-complete** across three independent reviews:

- **Cowork** (Claude, file-grounded factual): corrections applied in
  `290bc1a`. Two minor playbook polish items (`5(f)` tracking-template
  location, `5(g)` Wed-or-later defer-to-Monday) closed 2026-05-21.
- **Gemini Deep Research** (external market): corrections applied in
  `6d352e9`. Verdict: the intersection of "self-hosted LLM gateway" and
  "verified secret detection" is empirically empty as of May 2026.
- **PAL adversarial-commenter** (gemini-2.5-flash via `mcp__pal__chat`):
  identified HS256 takedown as the highest-likelihood hostile critique.
  Pre-emptive fixes rejected; canned reply pre-staged in `8a92650`.

Hour 3 (operator-led posting + +7d observation) is **live**:

| Date | Event | +7d decision window closes |
|---|---|---|
| 2026-05-18 Mon | r/selfhosted megathread + r/devops weekly self-promo thread | 2026-05-25 |
| 2026-05-19 Tue | Show HN (Variant 3 of `docs/hour-2-posts.md`) | 2026-05-26 |
| **on or after 2026-05-26** | **Decision commit due, tagged `validation-2026-05`** | — |

The Reddit pivot to megathreads (not top-level posts) was forced by
subreddit age rules — r/selfhosted requires 3-month-old repos for new-
project submissions, r/devops routes all self-promotion to a weekly
thread. Show HN is the only true standalone venue; decision criteria
should weight Show HN signal heavier than megathread-comment signal even
though the playbook's "≥3 sum across all three" rule wasn't formally
updated for the pivot.

The decision rule (sum of `operator_shaped_replies + deploy_intent` across
all three venues, per `docs/hour-3-playbook.md` §"Decision framework"):

| Sum | Decision |
|---|---|
| **≥3** | **Invest** — 1-week sprint, scope below |
| **1–2** | **Park** — repo public as portfolio + slow-burn OSS |
| **0** | **Shelve** — codebase stays as portfolio artifact |

"Operator-shaped" is defined precisely in `docs/hour-3-playbook.md`
§"What counts as an operator-shaped account" — post history in
self-hosted / devops / security / SRE spaces in the last 90 days, real
GitHub or domain link in profile, account age ≥7 days. Generic "cool
project" comments do not count, even at high upvote volume.

### Operator-only follow-ups currently open

None block the decision commit, but flagged across prior handoffs:

- **`systemd-analyze verify examples/systemd/keybroker.service`** on a
  Linux host. Unit shape looks correct (Type/User/Group/ExecStart/
  hardening flags) but hasn't been booted.
- **Add `libsecret-1-dev` to systemd unit install header.** On a fresh
  Ubuntu install, following the unit's install instructions verbatim
  produces a broker that fails at start — `src/keychain.ts:1` dlopens
  libsecret at module-init time even when `KEYBROKER_KEYCHAIN_PATH` is
  set. See trap memory `keytar_libsecret_load`.
- **Web UI `scan_verified=1` screenshot.** Complementary to the
  asciinema cast (https://asciinema.org/a/xGIIqfLVngSKHt8e), not a
  substitute. The cast shows `scan_verified=0` against an inactive
  `ghp_`; the screenshot should show a `verified=1` row from a
  throwaway account, with the PAT revoked + identifying strings
  scrubbed per `docs/hour-3-playbook.md` pre-flight.
- **Dispatcher → keybroker dogfooding flip.** Sequence: start broker
  daemon → confirm `/health` returns 200 → add `keybroker:
  {enabled: true, ...}` block to dispatcher `local.json` (not
  `budget.json`; see trap memory `dispatcher_broker_routing_setup`).

### If the decision is "invest" — 1-week sprint scope

Bounded scope from `docs/POSITIONING.md`. One week of evening effort.
No scope creep mid-sprint.

1. **RS256 signing for management JWTs.** Asymmetric signing so a
   verifier-only service can validate tokens without holding the signing
   key. Default stays HS256 for the single-box appliance shape; RS256
   opt-in via `--signing-algo rs256`. Closes the most likely hostile
   critique per PAL audit ("HS256-only is fundamentally insecure for a
   security tool"). The canned single-tenant defense at
   `docs/hour-3-playbook.md` §"Expected high-likelihood takedown" still
   stands for default deployments; RS256 removes the architectural
   blocker for multi-broker fleets.
2. **Broker basic auth.** `--admin-user` / `--admin-pass` pair so the
   broker can bind beyond `127.0.0.1` without leaving `/admin/*`
   unauthenticated. Loopback default unchanged; basic auth is opt-in
   for LAN deployments.
3. **One good `examples/docker-compose.yml`.** Broker container,
   mounted volume for `~/.keybroker`, env-var keychain config,
   healthcheck endpoint. Companion `docs/docker.md` walkthrough.
   Lifts the "where's the Dockerfile" objection the hour-2 posts
   pre-emptively concede.
4. **Lighthouse user outreach.** DM operator-shaped commenters from the
   validation experiment. Offer help. Target: one team running
   keybroker for real, willing to be quoted in README.

After the sprint: one lighthouse lands → 12-month side-income shape per
`POSITIONING.md` §"If the answer is yes." Nothing lands → quietly park.

### If the decision is "park"

Park means the commercial bet didn't land but the code stays alive
as a personal tool + portfolio artifact. Mechanical post-decision
actions, all bounded:

- **README banner.** Add a `> **Project status (May 2026):**
  validation experiment closed; project is in maintenance mode +
  personal-tool use. Issues and PRs handled best-effort.` line
  directly under the H1.
- **Dispatcher dogfooding flip.** Wire `claude-budget-dispatcher` to
  route through the broker per trap memory
  `dispatcher_broker_routing_setup`. Start daemon, confirm `/health`,
  add the `keybroker` block to dispatcher `local.json`. ~30 min of
  work. Converts the project from "demo" to "thing I actually use
  every day on my own fleet" — which is both the most honest pitch
  and a real test of whether any of the lurking bugs matter.
- **One technical blog post.** Pick *one* of: (1) "Home-rolling SigV4
  STS in ~150 LoC instead of pulling in @aws-sdk," (2) "Decode-then-
  scan: why Layer 1 secret detection is trivially bypassed by base64,"
  (3) "Fleet ops in a terminal: building an Ink TUI for an LLM
  proxy." Reuse the existing asciinema cast
  (https://asciinema.org/a/xGIIqfLVngSKHt8e) where it fits. One post,
  one weekend, not three.
- **Memory update.** `project_validation_experiment_state` rewritten
  to reflect outcome; the freeze-watch role of that memory ends.
- **Revisit trigger.** Either BoardBound (operator's primary project)
  hits its next monetization milestone, *or* an unsolicited operator
  raises a real deployment question on the repo (issue / discussion /
  email). Whichever comes first. If neither has happened by
  2026-11-30, transition to shelve.

### If the decision is "shelve"

Shelve means even the personal-tool premise didn't hold up — the
project is closed out as a portfolio artifact, no future investment
planned. Mechanical actions:

- **README banner.** Stronger version of the park banner:
  `> **Project status (May 2026):** validation experiment closed;
  this repository is archived as a portfolio artifact. Not under
  active development. The code works as documented for the operator's
  own use.`
- **One technical blog post anyway.** Same scope as park — pick one
  of the three topics above. The post is durable output regardless
  of project status, and the writing solidifies the systems work for
  the operator's own portfolio.
- **Defer `gh repo archive` by 30 days.** Archive locks the repo
  read-only, which kills drive-by issue / PR / star activity. Wait
  through one cycle of post-shelve discoverability before locking.
  Set a calendar reminder for 2026-06-25 (or T+30 from the actual
  shelve commit date) to revisit the archive decision.
- **No dispatcher dogfooding flip.** Skipping the wire-up is the
  honest reflection of "this project is done"; running unrelated
  side software on the BoardBound fleet adds operational risk for no
  matching upside.
- **Memory cleanup.** `project_validation_experiment_state` rewritten
  to reflect shelve outcome; Phase-4.x decision memories
  (`decision_phase_4_*`) retained as historical context but their
  freeze-watch role ends. Codebase keeps the portfolio value of Layer
  2 verify + scanner + web UI + TUI + FinOps forecasting + home-rolled
  SigV4 — all real systems work, all reviewable evidence of senior
  security / platform engineering capability.

### Anti-roadmap (current)

This supersedes the historical anti-roadmap at the bottom of the file
(which is preserved verbatim under "Implementation history").

- **No pre-emptive Pro-tier work.** The hard rule from POSITIONING.md.
  The temptation to "start building so we're ready if invest hits" is
  the exact failure mode the freeze exists to prevent.
- **No headline or draft rewrites mid-experiment.** Even if early signal
  is weak. The experiment is testing a held-steady message across three
  venues; rewriting on the fly destroys the signal it's trying to
  measure.
- **No multi-tenant / orgs / RBAC / SSO.** One operator's fleet.
- **No JIT elevation via Slack, no GHA OIDC, no Datadog/S3 audit
  shipping.** All anti-roadmap from v0.1 still applies.
- **No new handoff files for trivial follow-ups.** Roll micro-fixes
  into commit bodies. A handoff is appropriate when there's a distinct
  artifact set and a known unfinished item that needs operator
  presence.

---

## Implementation history

The phased plan below was written for v0.1 before any of Phases 1–4
shipped. It is preserved as the original implementation roadmap; the
"Where we are" section above is the authoritative current statement of
direction. Phase ✅ markers indicate what landed; the "Phase 4 —
Hardening" block here is *not* the same as the Phase 4.0 / 4.1 / 4.2
that actually shipped (web UI + TUI + Layer 2 verify) — those original
"Phase 4 — Hardening" items overlap heavily with the invest-path
1-week sprint scope above.

Phases were originally ordered by what unblocks what. Each had a
concrete "done when…" so the author would know when to move on instead
of polishing.

---

## Phase 1 — Production minimums  ✅ shipped

**Goal:** make the broker safe to leave running, without changing what it
does. None of these are new features; they're the table stakes the
prototype skipped to stay short.

### 1.1 Streaming pass-through

The current proxy buffers the upstream response into memory before
returning. That's fine for `/v1/embeddings` but breaks SSE/streamed
completions, which is most LLM traffic. Without this, the dispatcher
integration is impossible.

- Replace the `arrayBuffer()` + `reply.send(buf)` path in `src/server.ts`
  with a streamed body (`reply.send(upstream.body)` — Fastify supports
  passing a Readable directly).
- Audit log entry needs to be written *after* the stream closes; capture
  byte counts via a `Transform` that increments a counter on each chunk.
- Status: untouched. **Done when:** `curl -N` against
  `POST /openai/v1/chat/completions` with `"stream": true` shows tokens
  arriving incrementally and the audit log records correct response bytes.

### 1.2 SQLite backend

Drop JSON storage. Use `node:sqlite` (built into Node 22.5+, zero native
deps). Same `Store` interface, two tables (`secrets`, `tokens`) and an
append-only `calls` table. Use a single transaction per `consumeToken` for
real atomicity instead of relying on the event loop.

- New `src/store-sqlite.ts`. Keep the JSON store behind a `--store=json`
  flag for the single-file CLI demo workflow.
- Migration: one-shot `keybroker migrate` that reads the JSON store and
  writes to SQLite. After it runs once, JSON store becomes read-only.
- **Done when:** two concurrent `tsx` processes hammering the same broker
  with `--max-calls 1` tokens never both succeed. (Currently safe by
  accident — sync `mutate` + single event loop. SQLite makes it safe by
  design.)

### 1.3 Master key in OS keychain

Stop storing `masterKeyHex` and `jwtSecret` in `~/.keybroker/config.json`.

- Windows: DPAPI via `node-dpapi` or a small N-API shim.
- macOS: Keychain via `keytar` (still maintained, despite Atom).
- Linux: libsecret via `keytar`.
- `keybroker init` writes a *reference* to the keychain entry, not the
  secret itself. On startup the broker reads the secret on demand.
- **Done when:** `cat ~/.keybroker/config.json` reveals nothing useful, and
  `keybroker init --rotate-keys` re-encrypts every stored upstream secret
  under a new master key without dropping any.

### 1.4 Tests + CI

- `vitest` with three buckets: `crypto.test.ts` (round-trip + tampering),
  `tokens.test.ts` (issue/verify/scope edge cases — including the boundary
  attacks fixed in the v0.1 audit), `proxy.test.ts` (end-to-end against
  the echo upstream).
- GitHub Actions: typecheck + tests on Node 22 / Windows + Linux.
- **Done when:** PRs run green, the boundary regressions in the audit
  commit are pinned by tests so they can't come back.

**Phase 1 done when:** broker can run for a week proxying real
streamed traffic without restarts, secrets aren't on disk, and CI is
green. After this point you can use it personally without flinching.

---

## Phase 2 — The Money Rule features  ✅ shipped

**Goal:** make the broker enforce the rules `~/.claude/CLAUDE.md` already
says you live by. This is what justifies the dispatcher integration: the
broker stops being a convenience layer and becomes a *guardrail*.

### 2.1 Model allowlist per token

A token issued for OpenAI should be able to say "only `gpt-4o-mini`,
nothing else." Right now scope only constrains method+path.

- New token claim `mdl: ["gpt-4o-mini"]` (empty/missing = no model
  restriction).
- Provider-specific request body inspection — for OpenAI, parse JSON body,
  read `.model`, compare. For Anthropic, same field name.
- Provider registry gains a `extractRequestedModel(body) => string | undefined`
  function so this stays per-provider.
- **Done when:** a token issued with `--model gpt-4o-mini` returns 403
  `model_not_allowed` for any other model, with the attempted model in
  the audit log.

### 2.2 Dollar spend caps  ✅ shipped 2026-05-09

Shipped form differs from the original sketch — see HANDOFF-2026-05-09-phase-2-2.md.

**As shipped:**
- Token claim is a flat `cap?: number` (USD) on `BrokerClaims`. Spend is
  computed *on demand* from the audit log (`SUM(actual ?? estimate)` over
  `outcome IN ('ok', 'error')`) rather than denormalized onto the token row,
  so the same claim shape works across machines without a token-row sync.
- Per-call audit gains `estimated_cost_usd` and `actual_cost_usd` REAL columns.
- Pre-flight: `pricing.estimateOutputCostUsd(model, max_tokens)` — explicitly
  output-only because the broker has no tokenizer. With a cap set, an
  unpriced model is denied `cap_unpriced_model` and a deny on the
  cumulative+estimate comparison is `cap_exceeded_estimate`.
- Post-call: 256KB tail buffer + `pricing.parseUsageFromUpstream` handles
  buffered JSON and SSE for both OpenAI and Anthropic shapes.
- Soft limits (warn at 80% / log at 100%) **not shipped** — neither was
  actually called for in the original brief once we had the structured
  `estimated_cost_usd` / `actual_cost_usd` columns. Operators can pull
  spend from the audit log directly.
- `stream_options.include_usage: true` injection **not shipped**. The proxy
  is content-agnostic; injecting client-visible fields would change request
  semantics. If a client wants reconciled actuals on streamed calls, they
  request usage themselves.

**Known limitations (Phase 4 hardening):**
- **TOCTOU on the cap check.** `sumCostUsdByToken(tokenId)` and the
  subsequent `appendCall` are not wrapped in a transaction, so two
  parallel requests can both pass the cap check before either's spend
  lands. Overrun bound: `inflight × per-call estimate`. SQLite WAL +
  busy_timeout gives concurrency without the lock chain that would
  serialize the cap check. Acceptable for personal-fleet posture; a
  serializable transaction wrapping check + initial appendCall would
  close it cleanly when needed.
- **Pre-flight is output-only.** `inputTokens=0` default means the cap
  fires only on the `max_tokens × output_price` ceiling. Operators
  must pad caps for input-heavy calls; reconciliation post-call uses
  real input/output counts. A future Phase that brings in a tokenizer
  can flip the default and rename `estimateOutputCostUsd` →
  `estimateCostUsd`.
- **Mid-stream kill on overrun** explicitly deferred (Phase 4).

### 2.3 Per-machine attribution

The dispatcher already has the concept of a per-machine identity (see the
recent `health-<host>.json` and membership commits). Tokens should carry
the issuing machine.

- New token claim `mch: "<hostname>"` populated automatically by `keybroker
  token issue` from `os.hostname()`.
- Audit log gains a `machine` column.
- New CLI: `keybroker logs --machine <name>` and `keybroker tokens
  --machine <name>` for fast filtering.
- New CLI: `keybroker revoke-all --machine <name>` for the
  laptop-was-stolen case.
- **Done when:** with three machines all using the same broker, the audit
  log unambiguously attributes every call, and revoking one machine doesn't
  affect the others.

### 2.4 Provider deny-list mode

The literal Money Rule encoded as broker policy.

- `~/.keybroker/policy.json` with `forbidden_models: ["gemini-3-pro-preview",
  "*-preview", ...]` and `allowed_providers: ["openai", "anthropic", "deepseek"]`.
- Policy is enforced *before* token scope — even a wildcard token can't
  reach a forbidden model.
- Policy file is read on every request (cheap; cache 1s); no restart needed
  for changes.
- **Done when:** adding `"gemini-3-pro-preview"` to `forbidden_models`
  causes any in-flight token to start getting 403s within a second.

**Phase 2 done when:** you can hand someone a `brk_` token with confidence
that they cannot spend more than $X, cannot call models outside an
allowlist, and you can revoke them in one command. This is the version
worth folding into the dispatcher.

---

## Phase 3 — Fold into `claude-budget-dispatcher`  ✅ primitives shipped (dogfooding flip pending — operator-only)

**Goal:** `claude-budget-dispatcher` stops handling raw provider keys.
Every outbound call goes through keybroker. The Money Rule is enforced
at the proxy layer instead of in dispatcher logic.

### 3.0 Machine-identity contract  ✅ shipped 2026-05-09

The `mch` JWT claim and every `--machine` filter (`token list`,
`revoke-all`, `logs`) normalize the input through `normalizeMachine`
in `src/hostname.ts`: **trim surrounding whitespace, then lowercase**.
Empty / whitespace-only → `undefined` (= no claim / no filter). No
trailing-dot stripping, no FQDN truncation, no DNS-charset filtering —
both sides of the broker/dispatcher boundary must apply the *same*
function or they will drift.

**The dispatcher (Phase 3.2) MUST mirror this rule.** Today it does
inline `hostname().toLowerCase()` at multiple sites in
`scripts/dispatch.mjs`, `scripts/lib/heartbeat.mjs`, etc. — the lowercase
half is already correct, but the trim half is implicit and the rule
is duplicated at every call site. When migrating the dispatcher, add a
single `normalizeMachine` helper (port the keybroker function verbatim,
do not add cleverness) and route every machine-identity write/compare
through it.

### 3.1 Embedded vs sidecar

Decide before writing code:

- **Sidecar** (broker is a separate process): clean separation, broker can
  be restarted independently, dispatcher is a normal HTTP client. One more
  process to babysit.
- **Embedded** (dispatcher imports `keybroker` as a library and calls
  `buildServer()` on a Unix socket or in-process HTTP): no extra process,
  but tight coupling — broker bugs can crash the dispatcher.

**Recommendation: sidecar.** The dispatcher already has supervisor logic
(canary, heartbeat, per-machine health). Adding "is keybroker running?" to
the existing health check is cheaper than reasoning about coupled
failures, and it preserves the broker's standalone testability.

### 3.2 Dispatcher migration

- `provider.mjs` (the dispatcher's routing module) currently holds
  per-provider API keys directly. Replace each `Bearer ${apiKey}` with a
  `brk_` token issued at startup and rotated periodically.
- Dispatcher startup: spawn `keybroker serve` if no broker is reachable on
  the expected port; mint per-machine, per-provider tokens with the
  current per-machine spend cap; add `KEYBROKER_PID` to dispatcher's
  process tree so a dispatcher restart cleans up its broker.
- Existing dispatcher canary checks: extend `health-<host>.json` to
  include `keybroker_ok: bool` and last spend totals.
- The orphaned-process bug we hit on 2026-05-08 with the PAL MCP server is
  the warning here: the broker is a long-lived stdio child of the
  dispatcher; reap it explicitly on dispatcher shutdown, don't rely on
  parent-death-on-Windows.

### 3.3 Audit unification

Right now the dispatcher writes to its own `status/` JSON files and the
broker writes to `~/.keybroker/calls.log.jsonl`. Pick one schema.

- Broker's JSONL is the right format (append-only, line-per-event,
  cheap to tail).
- Dispatcher's existing per-machine status files become *summary
  rollups* derived from the broker log, not primary records.
- Keep the broker log as the source of truth; nothing else can falsify it.

**Phase 3 done when:** `provider.mjs` contains zero `Bearer sk-...`
strings, every dispatcher call produces a broker audit entry, and
`keybroker logs --machine <name>` is the canonical way to see what the
fleet did today.

---

## Phase 4 — Hardening (post-integration)  ⏸ deferred — overlaps invest-path 1-week sprint scope above

> **Note:** the "Phase 4.x" that actually shipped (4.0 web UI / 4.1 TUI /
> 4.2 Layer 2 verify) is a different, later-numbered phase that the v0.1
> plan didn't anticipate. The items below remain as written from the
> v0.1 plan; RS256, rate limits, and streaming spend kill are now
> rolled into the invest-path sprint scope under "Where we are" above.

Only worth doing once the dispatcher is on the broker and you've felt the
rough edges in production. Don't pre-build these.

- **RS256 with rotating signing keys.** Verifier-only services can check
  tokens without holding the signing key. Useful when you have multiple
  brokers behind a load balancer; not useful for a single-box fleet.
- **mTLS or OIDC** on the broker itself, so it can bind beyond `127.0.0.1`.
  Required only if you ever want to share the broker between machines on a
  LAN. Probably overkill — easier to run a broker per machine.
- **Per-second / per-minute rate limits.** `--max-calls` is a *total* cap;
  add `--rate 10/m` for sustained-traffic protection. Implement as a
  sliding window in the same SQLite store.
- **Streaming spend tracking.** The Phase 2 implementation parses cost at
  end-of-stream. For very long completions, kill the stream mid-flight if
  cost exceeds the cap (token-count → estimated-cost on each chunk).
  Cosmetic until you actually have a runaway $50 streaming call.
- **WebSocket support.** Some providers (Anthropic batch, OpenAI realtime)
  need WS. Different code path than HTTP — defer until needed.

---

## Phase 5 — Distribution  ⏸ deferred — only if lighthouse user lands post-invest

Only relevant if you ever decide to publish this for other people. None of
this is needed for personal-fleet use.

- `npm i -g keybroker`: prebuilt binaries via `pkg` or `bun build
  --compile`, since the prototype's `tsx` requirement is a sharp edge.
- SDK injectors:
  - `keybroker-openai`: monkey-patches `openai` so `import OpenAI from
    "openai"` auto-picks up `KEYBROKER_URL`.
  - Same for `@anthropic-ai/sdk`, `langchain`, `litellm`.
  - The pitch is "one-line code change" — the injector library *is* that
    line.
- Docker image, Helm chart, etc. for teams.
- A web dashboard for non-CLI users — not a priority, but a stepping
  stone if you ever decide to charge for this.

---

## Anti-roadmap

Things that look like they belong on this list but should not be built
until *after* a real user is asking for them:

- **Multi-tenant / orgs / RBAC.** This is one user's fleet. Don't build
  for hypothetical second users.
- **Just-in-time elevation via Slack bot.** Cool demo, zero value to a
  one-person operation.
- **GitHub Actions OIDC.** The dispatcher doesn't run in GHA.
- **Web UI for token issuance.** CLI is faster for the workflow, and a UI
  is significant effort.
- **Audit-log shipping to Datadog/S3/etc.** The `.jsonl` file is already
  the right shape; if you ever need to ship it, `tail -f | jq | curl` is
  fine.
- **Mobile app, browser extension, etc.** Don't.

The version of this project that is "fully operational" for the
dispatcher is the end of Phase 3. Everything after that is response to
real pain, not anticipation of it.
