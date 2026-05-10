# Handoff — keybroker Phase 2.3 complete (2026-05-09)

You are the next instance. Phase 2.3 (per-machine attribution) shipped today.
Phase 2 execution order continues: **2.2** is the last 2.x phase.

## State of `main`

```
febcaec  add per-machine token attribution (Phase 2.3)             ← HEAD
34430c5  add fleet policy: forbidden_models + allowed_providers (Phase 2.4)
d53fb68  tighten model allow-list semantics per code review
1ae7893  add per-token model allow-list (Phase 2.1)
17d50a6  add GitHub Actions CI: typecheck + tests on Node 22 / Ubuntu+Windows (Phase 1.4-B)
```

- Phase 2.3 commit pushed to `origin/main` (will be — see "Final state" below).
- Working tree clean.
- **177/177 tests pass** on Node 22. Up 23 from Phase 2.4's 154 — three new test
  blocks: `tokens.test.ts` mch round-trip + malformed (incl. empty-string
  rejection added per audit), `store.test.ts` machine round-trip across both
  stores + idempotent migration test, `proxy.test.ts` machine flow + 3-machine
  acceptance test.
- `npm run typecheck` clean.
- README is still intentionally stale (carry-over from Phase 2.4).

## What Phase 2.3 delivered

| Piece | Detail |
| --- | --- |
| `mch` JWT claim | Optional `mch?: string` on `BrokerClaims`. `issueToken` accepts a `machine?: string` arg; populated from `os.hostname()` at issue time by the CLI. Empty string → no claim (issue-time guard). `verifyToken` rejects non-string AND empty-string `mch`. |
| `machine` audit column | `CallLogEntry.machine?: string` and `TokenRecord.machine?: string`. Threaded through both `JsonStore` (free, JSON round-trips) and `SqliteStore` (new column + idempotent migration). |
| Server wiring | `const machine = claims.mch` captured exactly once after `verifyToken` succeeds. Threaded into `denied()` ctx for every post-verify denial AND into all three `appendCall` paths (success in `finished()`, error in `finished()`, upstream catch). Pre-verify denials (`unknown_provider`, `no_token`, `invalid_token`) intentionally do NOT include machine — claims are unverified, attacker controls the value. |
| SqliteStore migration | New `addColumnIfMissing()` helper extracts the Phase-2.1 duplicate-column-name swallow pattern. Three calls: `requested_model` (still here for legacy DBs that pre-date 2.1), `calls.machine`, `tokens.machine`. Indexes (`calls_machine_idx`, `calls_token_machine_idx`, `tokens_machine_idx`) created INSIDE `migrate()` after the ALTERs so legacy DBs upgrade cleanly. The composite `calls(token_id, machine)` index is for `selectCallsByTokenAndMachine`. |
| CLI | `token issue --machine <name>` (default `os.hostname()`, `--machine ''` to opt out). `token list --machine <name>` filter + display. `logs --machine <name>` filter + display. New `token revoke-all --machine <name>` with interactive `yes` confirmation (skip with `--yes`). |

### New CallLog reason codes

None — denials surface their existing reason codes; only the structured
`machine` column is new.

### Acceptance criterion verified

> "with three machines all using the same broker, the audit log unambiguously
> attributes every call, and revoking one machine doesn't affect the others."

`tests/proxy.test.ts > proxy: machine attribution (Phase 2.3) > acceptance:
three machines → audit unambiguously attributes every call, and revoke-all
isolates by machine` exercises the full flow against the in-process broker.

## Things the next instance should know

### 1. Hostname normalization is **deferred**

Both broker (`mch` claim) and dispatcher (`health-<host>.json`) call `os.hostname()` raw. If a real-world drift appears (Windows preserves case; some Linux configs include trailing dots), normalize in **one place** and document it. Do NOT add two normalization layers — they will drift. This is the one open contract for Phase 3.

### 2. The `--machine ''` opt-out is a sentinel

Empty-string-to-CLI means "no claim, no record". Translated to `undefined` in `cli.ts` and suppressed in both the JWT payload and the `TokenRecord`. If you ever extend the field to allow `*` or other special values, audit `cli.ts:271` (the `opts.machine === ""` check) so empty isn't ambiguous.

### 3. `verifyToken` rejects empty-string `mch`

Added per the audit. `issueToken` already won't produce one, but a hand-crafted JWT with `mch: ""` should not log a phantom empty-string machine. If you ever loosen `mch` validation, also revisit the `addColumnIfMissing` migration — `machine TEXT NULL` semantics in the DB still allow the absence-vs-empty distinction.

### 4. `revoke-all` is interactive by default

The handoff for 2.4 said "be explicit about how many tokens are about to be revoked". I went one step further per audit: print the count + per-token preview, then read 'yes' from stdin. `--yes` skips for scripts/CI. If Phase 4 hardening adds a `keybroker token revoke --batch <ids>` family, mirror this pattern.

### 5. `addColumnIfMissing()` is the migration helper now

Old code inlined the PRAGMA + try/swallow-duplicate-column-name pattern. Phase 2.3 extracted it because it had three call sites. Phase 2.2 (and any future column add) should use it rather than re-inlining. See `src/store-sqlite.ts` bottom.

### 6. `recentCalls()` is now an if/else ladder over four prepared statements

Possible (tokenId, machine) combinations: neither, tokenId-only, machine-only, both. Each branch picks the right prepared statement so SQLite uses the right index. If you add a third filter dimension in 2.2 (e.g. provider), this ladder grows quadratically — at that point switch to dynamic SQL composition with a guarded WHERE-clause builder, or accept three filters become eight statements (still tractable, but tipping).

### 7. CRLF noise on Windows

Same as Phase 2.4: every commit prints `LF will be replaced by CRLF` warnings. Normal. Don't try to "fix" it — the files were authored with LF and git's autocrlf rewrites on checkout.

## What's next — Phase 2.2 (dollar spend caps)

This is the last Phase 2 item. ROADMAP excerpt:

> Token-scoped dollar caps. Each token gets an optional `cap_usd` claim;
> the broker estimates per-call cost from `model` + `max_tokens` and refuses
> requests that would exceed the cap. Post-call `usage` is parsed (when
> upstream returns it) and the running spend is decremented from the cap.

### Sketch / pre-work for 2.2

- **Pricing table.** New file `src/pricing.ts`. Map of `model name → { inputUsdPerMTok, outputUsdPerMTok }`. Populate for openai + anthropic. Glob support? Probably yes — reuse `src/glob-match.ts` (the Phase 2.4 helper) so `gpt-4o-mini*` matches.
- **Token claim.** Add `cap?: number` to `BrokerClaims` (USD; `0` or missing = no cap). Validate `typeof cap === "number"` in `verifyToken`. CLI `--cap-usd <n>` flag on `token issue`.
- **Audit columns.** `CallLogEntry.estimatedCostUsd?: number` and `actualCostUsd?: number`. Same `addColumnIfMissing` migration pattern.
- **Pre-flight check.** Inside the existing `case "ok"` arm of the model gate (`server.ts` ~line 184), reuse `extraction.meta` (which already has `model`, `stream`, `maxTokens`). Compute `estimated = inputTokens (?? 0) * inPrice + maxTokens * outPrice`. If `cumulativeSpend + estimated > cap`, deny with new reason `cap_exceeded_estimate`.
- **Post-call usage parse.** Tricky for streaming. OpenAI honors `stream_options.include_usage: true` — the final SSE event contains a `usage` object. The proxy already pipes through a `Transform` (server.ts:362). Extend it to parse final SSE events for a `usage` field; for buffered (non-stream) responses, JSON-parse the body once. Update `actualCostUsd` and the running spend total in `appendCall`.
- **Where to store running spend.** Two options: (a) compute on demand from `recentCalls`, or (b) add a `spent_usd REAL` column to `tokens` that's atomically updated alongside `consumeToken`. (b) is faster but races with `consumeToken`'s single-statement atomicity guarantee — tread carefully. (a) is simpler and accurate for caps that are checked once per request.
- **CLI display.** `token list` should show `spent=$X / cap=$Y` if cap is set.

### Open questions for 2.2

1. **Pricing table currency.** USD only, or quote in the model's source currency? Personal-fleet — USD only is fine. Document.
2. **Streaming cost reconciliation.** Mid-stream kill on overrun is in Phase 4. For 2.2, the contract is "post-stream usage is decremented; estimate is enforced pre-flight". Decide and document.
3. **Cap reset.** Per-token absolute cap (decrements until exhausted) vs. periodic reset (daily / weekly)? Roadmap implies absolute; mention if you change it.

## Carry-over deferrals (NOT mine to fix in 2.2)

These are aging but explicitly out of 2.2 scope:

| Item | Origin | Why deferred |
| --- | --- | --- |
| README cleanup | Phase 1.x — claims "no streaming proxy", "JSON-file storage", "master key in plaintext", "no tests". All untrue post-Phase-1. | Phase 2.1 / 2.4 / 2.3 all skipped. Plan: one sweep at end of Phase 2 (after 2.2) or top of Phase 3, when feature surface is stable. |
| Content-Type-aware extraction (so `--model whisper-1` tokens can hit `/v1/audio/transcriptions`) | Phase 2.1 (gemini "HIGH" finding intentionally not applied) | Widens the trust boundary onto a client-supplied header. Personal-fleet preference is "issue separate tokens for separate concerns". |
| Sub-millisecond glob match cache eviction | Phase 2.4 | Unbounded cache map in `src/glob-match.ts`. In practice tiny. Don't add LRU until there's a reason. |
| Hostname normalization between broker and dispatcher | Phase 2.3 | Both sides use raw `os.hostname()`. If drift appears, normalize in ONE place. |

## Deferred to post-Phase-3 (Phase 4 hardening)

- RS256 signing keys
- mTLS / OIDC for the broker bind
- Per-second rate limits beyond `--max-calls`
- Mid-stream kill on spend overrun (Phase 2.2 only does end-of-stream)
- WebSocket support
- Interactive prompts upgraded to a proper TTY library (current readline approach is fine for personal fleet)

These are in `ROADMAP.md` Phase 4. Don't pre-build.

## Useful commands

```sh
# from C:/Users/perry/DevProjects/keybroker
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run (all 177)
npm run test:watch                      # iterate
git log --oneline origin/main..HEAD     # confirm nothing unpushed

# Issue + revoke-all smoke
npx tsx src/cli.ts token issue --provider echo --machine alpha --label smoke
npx tsx src/cli.ts token list --machine alpha
npx tsx src/cli.ts token revoke-all --machine alpha   # prompts for 'yes'
npx tsx src/cli.ts token revoke-all --machine alpha --yes  # non-interactive
```

## Final state

- `febcaec` on local `main`. Push pending — the next instance (or me at session end) should `git push`.
- 177/177 tests green locally; CI matrix should match.
- Phase 2.2 is your next pickup.

Take your time.
