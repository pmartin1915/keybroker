# Handoff — keybroker Phase 2.2 complete (2026-05-09)

You are the next instance. Phase 2.2 (token-scoped USD spend caps) shipped today.
This was the last 2.x phase. Phase 3 is open.

## State of `main`

```
<this-commit>  add token-scoped USD spend caps (Phase 2.2)
02edcb9        add handoff for Phase 2.3 → 2.2 transition
febcaec        add per-machine token attribution (Phase 2.3)
34430c5        add fleet policy: forbidden_models + allowed_providers (Phase 2.4)
1ae7893        add per-token model allow-list (Phase 2.1)
```

- Working tree clean after this commit.
- **229/229 tests pass** on Node 22. Up 52 from Phase 2.3's 177 — four new
  blocks: `tokens.test.ts` cap claim round-trip + 6 malformed shapes,
  `store.test.ts` cost columns + sumCostUsdByToken edge cases +
  idempotent migration test, `proxy.test.ts` cap pre-flight + post-call
  reconciliation + acceptance test, `pricing.test.ts` (NEW, full module
  coverage including SSE shape detection).
- `npm run typecheck` clean.
- README still intentionally stale — three Phase 2 phases punted on it.
  Plan: one sweep at top of Phase 3 when feature surface is stable.

## What Phase 2.2 delivered

| Piece | Detail |
| --- | --- |
| `cap` JWT claim | Optional `cap?: number` on `BrokerClaims` (USD, decimals). `issueToken` accepts `capUsd?: number`; throws on negative / non-finite. `0` and `undefined` both mean "no cap" by contract. `verifyToken` rejects malformed (non-number, non-finite, ≤0) so a hand-crafted JWT with `cap: 0` cannot bypass enforcement (the cap branch only fires on `cap > 0`). |
| `estimated_cost_usd` / `actual_cost_usd` columns | Both REAL on `calls`. `addColumnIfMissing` migrations idempotent on pre-2.2 DBs. Threaded through `JsonStore` (free, JSON round-trips) and `SqliteStore`. `rowToCall` preserves null vs zero. |
| `cap_usd` on `tokens` | Display-only; the JWT is the source of truth for enforcement. Stored on the record so `keybroker token list` can show `spent=$X / cap=$Y` without decoding every JWT. |
| `src/pricing.ts` (NEW) | Glob-matched pricing table for openai + anthropic. `priceForModel`, `estimateOutputCostUsd` (deliberately output-only — name reflects the limitation), `actualCostUsd`, `parseUsageFromUpstream` (handles buffered JSON + SSE for both shapes; OpenAI `prompt_tokens/completion_tokens`, Anthropic `input_tokens/output_tokens`, including Anthropic's `message.usage` nesting). |
| `StoreLike.sumCostUsdByToken(id)` | `SUM(COALESCE(actual_cost_usd, estimated_cost_usd))` with **allowlist** filter `outcome IN ('ok', 'error')` — applied per gemini's audit. Mirrored in JsonStore so both backends report the same number. |
| Server pre-flight | Inside `case "ok"` of the model gate: `est = estimateOutputCostUsd(model, maxTokens)`. With cap set: unpriced model → `cap_unpriced_model`; `cumulative + est > cap` → `cap_exceeded_estimate`. Both denials go through `denied()` with `requestedModel` populated. |
| Server post-call | `Transform` retains a 256KB tail buffer. On `finished()`, `parseUsageFromUpstream(Buffer.concat(tail))` extracts usage and `actualCostUsdFor` converts to dollars. New `finalizeCallEntry` helper collapses the three appendCall sites (success, stream error, upstream-catch). |
| Cap-aware deny coverage | `cap_unpriced_model` fires on three paths: extractor-missing, `unparseable`/`no-model`, and `ok`-but-unpriced. A capped token cannot reach upstream without producing an estimate. |
| Quota invariant preserved | Cap denials run BEFORE `consumeToken`, so a cap deny does not burn a quota slot — same pattern as Phase 2.1's mdl deny. |
| CLI | `--cap-usd <n>` on `token issue` (validates ≥0 finite; help text warns about output-only pre-flight). `token list` shows `spent=$X.XXXX/cap=$Y.YY` when set. |

### New CallLog reason codes

- `cap_exceeded_estimate` — pre-flight estimate would push the token's
  cumulative spend above its cap.
- `cap_unpriced_model` — capped token issued a request the broker can't
  price (unknown model, missing model field, or non-LLM provider).

### Acceptance criterion verified

> "a `--cap-usd 0.50` token can make many cheap calls but is rejected the
> moment a single call would push it past the cap."

`tests/proxy.test.ts > proxy: USD cap enforcement (Phase 2.2) > acceptance`
exercises the full flow against the in-process broker: $0.50 cap, two
gpt-4o-mini calls each reconciled to $0.30 (using an extended echo
upstream that returns `{usage:{prompt_tokens, completion_tokens}}`), the
third pre-flight + cumulative ($0.60) exceeds $0.50 and is denied.
`sumCostUsdByToken` confirms the denied call did not contribute.

## Things the next instance should know

### 1. Pre-flight estimate is OUTPUT-ONLY

`estimateOutputCostUsd` defaults `inputTokens` to 0 because the broker has
no tokenizer. The cap fires on `max_tokens × output_price` only — input
cost is reconciled post-call from real upstream usage. Operators MUST pad
caps for input-heavy calls. The function name was chosen to make this
visible at every call site; the CLI help text on `--cap-usd` warns about
it; ROADMAP.md tracks it as a known limitation. If a future Phase brings
in a tokenizer, flip the default and rename `estimateOutputCostUsd` →
`estimateCostUsd`.

### 2. TOCTOU between cap check and appendCall — documented, not closed

Two concurrent requests can both pass the cap check before either's
spend lands in the audit log. Overrun bound: `inflight × per-call
estimate`. The cap check + consumeToken + appendCall is not wrapped in
a transaction (mirroring Phase 2.1's mdl check); SQLite WAL gives
concurrency without serializing on the cap. ROADMAP marks this as
Phase 4 hardening. If you decide to close it, wrap check + initial
appendCall in a serializable transaction — but consumeToken's
single-statement atomicity guarantee should not be broken.

### 3. 256KB tail buffer for streaming usage parse — provider-contract assumption

OpenAI (`stream_options.include_usage:true`) and Anthropic both place
usage in the LAST events of the stream. If a future provider emits usage
early then continues streaming >256KB, the usage event would be evicted
and the system falls back to the pre-flight estimate. The fail-closed
posture (silent fallback rather than over-bill) is documented inline at
`server.ts` and in ROADMAP. When adding a new provider, verify its
streaming usage placement and bump RESP_TAIL_CAP if needed.

### 4. Spend allowlist semantics

Per gemini's audit, `sumCostUsdByToken` uses `outcome IN ('ok', 'error')`
not `outcome != 'denied'`. This is deliberate: a future "did-not-reach-
upstream" outcome (e.g. a hypothetical `rate_limited`) would NOT silently
contribute to spend — whoever adds it has to update the allowlist
deliberately. The two stores are kept in sync; if you add an outcome,
update both `store-sqlite.ts` (SQL `IN` clause) and `store-json.ts`
(TypeScript filter).

### 5. `cap_usd` on TokenRecord is display-only — JWT is the truth

Mirrors how the JWT carries `mch` for enforcement and the TokenRecord
carries `machine` for filtering. A stale TokenRecord (e.g. partial
restore) cannot loosen enforcement, only mis-display. If you ever build
a "cap rotation" feature, do it by reissuing the token rather than
mutating the existing TokenRecord.

### 6. Pricing table is hardcoded on purpose

`src/pricing.ts` declares an ordered glob list. Order matters: the
first matching pattern wins, so `gpt-4o-mini*` MUST come before
`gpt-4o*` (otherwise mini would be billed at the gpt-4o rate, ~17×
overestimate, and `cap_exceeded_estimate` would fire on calls that
should pass). `tests/pricing.test.ts > priceForModel: glob lookup
ordering > most specific glob wins over a broader one` pins this. When
adding a new pattern, place it before any broader glob it should
override.

### 7. `parseUsageFromUpstream` failure mode is silent

A malformed event leaves `actualCostUsd` undefined and the cap
accounting falls back to the pre-flight estimate, which already counted
toward the cap. This is the correct fail-closed posture — over-billing
on a parse failure would penalize the token holder for an upstream bug.

### 8. CRLF noise on Windows

Same as Phase 2.3 / 2.4: every commit prints `LF will be replaced by
CRLF` warnings. Normal — don't try to "fix" it.

## What's next — Phase 3 (open)

Phase 2 is complete. ROADMAP Phase 3 is the broker-fleet integration
layer (multi-broker coordination, dispatcher contract). The hostname
normalization carry-over from Phase 2.3 is the first concrete item to
resolve there.

### Phase 4 hardening backlog (deferred)

Tracked in ROADMAP.md but listed here because Phase 2.2 added items:

- TOCTOU race on cap check (this phase).
- Mid-stream kill on cap overrun (this phase — current contract is
  end-of-stream reconciliation only).
- RS256 signing keys.
- mTLS / OIDC for the broker bind.
- Per-second rate limits beyond `--max-calls`.
- WebSocket support.
- Real tokenizer for accurate input-cost estimation.
- README cleanup (carries from Phase 1).

## Carry-over deferrals (NOT mine to fix in Phase 3 unless adopted)

| Item | Origin | Why deferred |
| --- | --- | --- |
| Hostname normalization between broker and dispatcher | Phase 2.3 | Both sides use raw `os.hostname()`. If drift appears, normalize in ONE place. |
| Content-Type-aware extraction | Phase 2.1 | Widens the trust boundary onto a client-supplied header. Personal-fleet preference is "issue separate tokens for separate concerns". |
| Sub-millisecond glob match cache eviction | Phase 2.4 | Unbounded cache map in `src/glob-match.ts`. In practice tiny. Don't add LRU until there's a reason. |
| README cleanup | Phase 1.x | All four Phase 2 instances skipped it. Plan: top of Phase 3. |

## Useful commands

```sh
# from C:/Users/perry/DevProjects/keybroker
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run (all 229)
npm run test:watch                      # iterate
git log --oneline origin/main..HEAD     # confirm nothing unpushed

# Phase 2.2 smoke
npx tsx src/cli.ts token issue --provider openai --cap-usd 0.50 --label smoke
npx tsx src/cli.ts token list           # shows "spent=$0.0000/cap=$0.50"
```

## Final state

- Phase 2.2 commit pending push by next instance (or me at session end).
- 229/229 tests green locally; CI matrix should match.
- Phase 3 is your next pickup.

External audit (gemini-2.5-pro via PAL `codereview`): 0 critical, 0 high,
2 medium (output-only estimate documented; TOCTOU race documented), 4 low
(all applied: outcome allowlist, tail-buffer comment, output-only rename,
CLI help text). Findings ratified the implementation as merge-ready.

Take your time.
