# Handoff — keybroker Phase 2.4 complete (2026-05-09)

You are the next instance. Phase 2.4 (fleet policy) shipped today.
Phase 2 execution order continues: **2.3 → 2.2**.

## State of `main`

```
34430c5  add fleet policy: forbidden_models + allowed_providers (Phase 2.4)   ← HEAD
d53fb68  tighten model allow-list semantics per code review
1ae7893  add per-token model allow-list (Phase 2.1)
17d50a6  add GitHub Actions CI: typecheck + tests on Node 22 / Ubuntu+Windows (Phase 1.4-B)
```

- All three Phase 2.x commits pushed to `origin/main`.
- Working tree clean.
- **154/154 tests pass** on Node 22 (8 existing test files + 3 new — `glob-match.test.ts`, `policy.test.ts`, `policy-proxy.test.ts`).
- `npm run typecheck` clean.
- README is intentionally stale (see "Carry-over deferrals" below).

## What Phase 2.4 delivered

| Piece | Detail |
| --- | --- |
| `~/.keybroker/policy.json` | Optional file. Two fields: `forbidden_models` (glob deny-list) and `allowed_providers` (allow-list). Both default to "no restriction" when missing/empty. |
| Glob matcher | `src/glob-match.ts`. Only `*` is special; every other char is literal. Compiled regex per pattern, cached. Patterns are operator-authored, no DoS surface. |
| Policy module | `src/policy.ts`. 1s TTL cache keyed by absolute path so concurrent test suites don't poison each other. Fail-OPEN on parse error — see gotcha below. |
| Server wiring | Policy provider check runs **after** token verify but **before** scope. Policy model check shares the existing `extractRequestMetadata` extraction with the per-token `mdl` claim. Scope check moved to **after** the model gate so policy denials report `model_forbidden` / `provider_forbidden` rather than being masked as `scope_denied`. |
| `mdl` upgrade | Per-token `mdl` claim now glob-matches via the shared utility. Existing exact-match tokens unaffected (literal patterns still match literally). CLI help text updated to document `--model gpt-4o-mini*` form. |
| `BrokerConfig.policyPath` | Plumbed through `loadConfig`. Tests had to add it to manual config literals (proxy/store/streaming). |

### New CallLog reason codes

- `provider_forbidden` — request hit a provider not in `allowed_providers`.
- `model_forbidden` — request body's `.model` matched a `forbidden_models` glob. The attempted model is recorded in the structured `requestedModel` column, not encoded into the reason string (consistent with Phase 2.1).

### Acceptance criterion verified

> "Adding `\"gemini-3-pro-preview\"` to `forbidden_models` causes any in-flight token to start getting 403s within a second."

`tests/policy-proxy.test.ts > policy: hot reload > real-time TTL` writes `policy.json` after a successful call, sleeps 1.2s **without manually invalidating the cache**, and verifies the next call gets `403 model_forbidden`.

## Things the next instance should know

### 1. Policy fails OPEN on parse error — intentional

If `policy.json` exists but is unparseable, `loadPolicy` logs a warning to stderr and returns the empty policy. Per-token `mdl` claims still apply.

**Why:** the policy file is opt-in. A typo during edit must not lock the operator out of their own tokens. If you ever flip this to fail-CLOSED, document it in the file-level comment in `src/policy.ts` AND update `README.md` (when the README sweep happens).

### 2. Cache is keyed by absolute path

`policy.ts` keeps a `Map<string, CacheEntry>`. Tests get isolation for free because `mkdtempSync` produces unique paths. `_resetPolicyCache(path?)` is exported for tests that want immediate invalidation without sleeping the TTL — production code never calls it.

### 3. Order in `server.ts` is now: provider lookup → token verify → provider mismatch → **policy provider** → body parse → **policy/mdl model gate** → scope → consumeToken

The "policy before scope" ordering matters for telemetry: an audit consumer should see `model_forbidden` rather than `scope_denied` when both would apply. If you reorder, also update the comments in `server.ts` that justify the order ("see roadmap 2.4: 'Policy is enforced *before* token scope'").

### 4. The model gate is the spot to extend for Phase 2.2

Phase 2.2 (dollar spend caps) needs the same `extractRequestMetadata` digest — it has `model`, `stream`, `maxTokens` already. The pre-flight cap estimate in 2.2 is most naturally added inside the existing `case "ok"` arm of the switch, immediately after `policyDeniesModel` and before / alongside the `mdl` check. Don't add a third extraction call somewhere else; reuse the one that's already there.

### 5. Glob matcher is shared

`src/glob-match.ts` is now used by both `policy.ts` (`forbiddenModels`) and `server.ts` (`mdl` claim). If Phase 2.2 grows pricing-table key matching or 2.4 adds another field, reuse it rather than re-implementing.

### 6. CI

GitHub Actions runs `typecheck` + `vitest` on Node 22, Ubuntu and Windows (Phase 1.4-B). 154/154 should be green on `34430c5`. If you see the matrix go red and you didn't change Node-API or filesystem semantics, look at the warning we saw locally:

```
LF will be replaced by CRLF the next time Git touches it
```

Files were created with LF on Windows; git's autocrlf will rewrite them. That's normal and not a bug — but it means a `git status` on Windows after a fresh clone may show modified files. Don't "fix" that.

## What's next — Phase 2.3 (per-machine attribution)

ROADMAP excerpt:

> Tokens should carry the issuing machine.
> - New token claim `mch: "<hostname>"` populated automatically by `keybroker token issue` from `os.hostname()`.
> - Audit log gains a `machine` column.
> - New CLI: `keybroker logs --machine <name>` and `keybroker tokens --machine <name>` for fast filtering.
> - New CLI: `keybroker revoke-all --machine <name>` for the laptop-was-stolen case.
> - **Done when:** with three machines all using the same broker, the audit log unambiguously attributes every call, and revoking one machine doesn't affect the others.

### Sketch / pre-work for 2.3

- **Token claim.** Add `mch?: string` to `BrokerClaims` in `src/tokens.ts`. Populate from `os.hostname()` at issue time. Don't enforce it on verify — old tokens without `mch` should still work (no breaking change).
- **Audit column.** `CallLogEntry.machine?: string` in `src/logging.ts`. Server reads `claims.mch` post-verify and threads through the same way `requestedModel` is threaded. SqliteStore needs an idempotent `ALTER TABLE calls ADD COLUMN machine TEXT` migration mirroring how Phase 2.1 added `requestedModel` (look at `d53fb68` for the pattern: try/catch on duplicate-column message; concurrent openers are the failure mode to defend against).
- **CLI overrides.** Allow `--machine <name>` on `token issue` so you can mint tokens for *another* machine from the central broker host. Default = `os.hostname()`.
- **`keybroker logs --machine <name>`** and **`keybroker tokens --machine <name>`**: just filters in the SqliteStore queries.
- **`keybroker revoke-all --machine <name>`**: bulk update `tokens.revoked = 1 WHERE label_or_machine = ...`. Be explicit in the CLI confirm message about how many tokens are about to be revoked.

### Open question for 2.3

The dispatcher (`claude-budget-dispatcher`) already keeps per-machine identity in `health-<host>.json` (Phase A/B from the dispatcher's own roadmap). When the broker integrates in Phase 3, it should reconcile its `mch` claim with the dispatcher's hostname — they should be the same string. The simplest contract: both sides use `os.hostname()` raw. If you find a reason to normalize (lowercase, strip trailing dots), do it in **one** place, document it, and apply consistently. Don't let two normalization layers drift.

## Phase 2.2 (deferred behind 2.3)

Per the original handoff and roadmap, 2.2 (dollar spend caps) lands last. Pricing table goes in `src/pricing.ts`; pre-flight cap check uses `meta.maxTokens` from the existing extraction; post-call `usage` parse needs to handle both buffered and streamed responses (OpenAI's `stream_options.include_usage: true` final SSE event is the streaming hook). The roadmap's "estimate from `max_tokens`" is the minimum-viable pre-flight check.

## Carry-over deferrals (NOT mine to fix in 2.3)

These are aging, but explicitly out of 2.3 scope:

| Item | Origin | Why deferred |
| --- | --- | --- |
| README cleanup | Phase 1.x — claims "no streaming proxy", "JSON-file storage", "master key in plaintext", "no tests". All untrue post-Phase-1. | Phase 2.1 also skipped this. Plan: one sweep at end of Phase 2 or top of Phase 3, when feature surface is stable. |
| Content-Type-aware extraction (so `--model whisper-1` tokens can hit `/v1/audio/transcriptions`) | Phase 2.1 (gemini "HIGH" finding intentionally not applied) | Widens the trust boundary onto a client-supplied header. Personal-fleet preference is "issue separate tokens for separate concerns". Still defensible; revisit only if a real workflow needs it. |
| Sub-millisecond glob match cache eviction | Phase 2.4 | The `cache` map in `src/glob-match.ts` is unbounded but in practice tiny (number of distinct operator-authored patterns). Don't add an LRU until there's a reason. |

## Deferred to post-Phase-3 (Phase 4 hardening)

- RS256 signing keys
- mTLS / OIDC for the broker bind
- Per-second rate limits beyond `--max-calls`
- Mid-stream kill on spend overrun (Phase 2.2 only does end-of-stream)
- WebSocket support

These are in `ROADMAP.md` Phase 4. Don't pre-build.

## Useful commands

```sh
# from C:/Users/perry/DevProjects/keybroker
npm run typecheck                     # tsc --noEmit
npm test                              # vitest run (all 154)
npm run test:watch                    # iterate
git log --oneline origin/main..HEAD   # confirm nothing unpushed
```

## Final state

- `34430c5` pushed to `origin/main`.
- 154/154 tests green locally; CI matrix should match.
- Phase 2.3 is your next pickup.

Take your time.
