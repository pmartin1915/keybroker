# Roadmap

The current state (v0.1) is a working prototype that demos the developer
experience. Everything below is what it would take to turn this into
something a real fleet — specifically `claude-budget-dispatcher` — can rely
on.

Phases are ordered by what unblocks what. Do not skip ahead. Each phase has
a concrete "done when…" so you know when to move on instead of polishing.

---

## Phase 1 — Production minimums

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

## Phase 2 — The Money Rule features

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

## Phase 3 — Fold into `claude-budget-dispatcher`

**Goal:** `claude-budget-dispatcher` stops handling raw provider keys.
Every outbound call goes through keybroker. The Money Rule is enforced
at the proxy layer instead of in dispatcher logic.

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

## Phase 4 — Hardening (post-integration)

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

## Phase 5 — Distribution

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
