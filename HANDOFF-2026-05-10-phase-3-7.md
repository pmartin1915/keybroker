# Handoff — keybroker Phase 3.7 complete (2026-05-10)

You are the next instance. Phase 3.7 — TTFT/TPOT latency telemetry,
the remaining prerequisite for Phase 4.0 (real frontend) — shipped as
a single commit on this turn. Working tree should be clean after the
commit. Phase 3.6 (inline scanner) shipped earlier today; see
`HANDOFF-2026-05-10-phase-3-6.md` for that context.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Audit schema (type) | `src/logging.ts` | `CallLogEntry` gains three optional fields: `ttftMs`, `tpotMsAvg`, `outputTokens`. Back-compat with pre-3.7 rows (denied / error / pre-migration audit lines have all three undefined). |
| SQLite migration | `src/store-sqlite.ts` | Idempotent `ALTER TABLE calls ADD COLUMN` for `ttft_ms REAL`, `tpot_ms_avg REAL`, `output_tokens INTEGER`. Same race-tolerant pattern as the 2.1/2.2/3.3 migrations. `CallRow` interface, `insertCall` SQL, all four `selectCalls*` projections, and `rowToCall` updated in lockstep. |
| Latency stats query | `src/store-sqlite.ts:latencyStatsByTokenSince` | New prepared statement `latencyStatsByTokenSince` projects `(ttft_ms, tpot_ms_avg, output_tokens)` for the token+window; the JS layer computes p50/p95 via `computeLatencyStats`. Same `outcome IN ('ok','error') AND ttft_ms IS NOT NULL` filter as the spend queries — denied / pre-flight-failed rows have no TTFT sample and don't pollute the distribution. |
| Percentile helper | `src/latency-stats.ts` (new) | `computeLatencyStats(ttfts, tpots)` — nearest-rank percentile (NIST), bit-identical between SQLite and JSON stores. Independent sample sizes per metric (TPOT can be undefined on a call with a valid TTFT). |
| JSON-store mirror | `src/store-json.ts:latencyStatsByTokenSince` | Same filter semantics as SQLite, scanning the JSONL log. Numeric-validity guards mirror the spend aggregators. |
| Proxy hot path | `src/server.ts` | Transform stream now captures `firstByteAt` on the first chunk and `finishedAt` in `flush`. `finalizeCallEntry` reads upstream `usage` once (same parse path as Phase 2.2's `actualCostUsd`), populates `outputTokens` when present, then computes `ttftMs = firstByteAt - started` and `tpotMsAvg = (finishedAt - firstByteAt) / outputTokens`. All three columns stay undefined when the stream emitted zero chunks. |
| Latency endpoint | `src/server.ts` | `GET /metrics/latency?token=<id>&since=<n>(s\|m\|h\|d)` — same trust posture as `/metrics/spend` and `/forecast/*` (open on 127.0.0.1, operator-facing). Required query params; returns `LatencyStats { sampleCount, p50TtftMs?, p95TtftMs?, p50TpotMsAvg?, p95TpotMsAvg? }`. |
| Tests | `tests/latency.test.ts` (new, 11 tests) | Streaming-upstream harness with `PREFILL_MS=80`, `CHUNK_GAP_MS=40`, `OUTPUT_TOKENS=6`, final `data: {usage:…}` SSE event. Asserts ttft/tpot/output_tokens populated on streamed completion, undefined on denied calls, `/metrics/latency` p50/p95 over 3 calls, 400s for missing params, and 4 unit tests on `computeLatencyStats` (empty input, known distribution, mismatched sample sizes, single sample). |
| Store interface | `src/store-types.ts` | `LatencyStats` interface added. `StoreLike.latencyStatsByTokenSince(tokenId, ts)` required of every backend. |
| Docs | `README.md` "What's enforced per token" | New row for Latency telemetry. |

**Tests:** 441 pass / 18 files (was 430 → +11 across Phase 3.7).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **TTFT is measured at the Transform's first chunk, not at
   `undiciRequest()` resolve.** undici resolves once response headers
   arrive, which for OpenAI/Anthropic typically precedes the first
   body byte (the prefill window). The Transform sees the actual
   content latency the dispatcher / dashboard cares about. If a
   future provider returns headers and body in the same TCP frame,
   the two timings will collapse; that's still semantically correct.
2. **`tpotMsAvg` is a per-call mean stored on the audit row, NOT
   per-chunk inter-arrival times.** Storing per-chunk samples would
   blow up the schema; the operator's question ("how fast is decode
   for this token") is well served by per-call means. The percentile
   endpoint then takes p50/p95 *of these means*, not of raw chunks.
   Document this if the FE team wires a "decode latency histogram"
   later — the histogram bins per-call means, not tokens.
3. **`outputTokens` comes from the existing usage parse path.** The
   Phase 2.2 reconciliation already calls `parseUsageFromUpstream`
   on the response tail; Phase 3.7 reuses it. Calls without usage
   (echo provider in tests, providers without
   `stream_options.include_usage`) get `ttftMs` populated but
   `outputTokens` and `tpotMsAvg` left undefined. The latency
   endpoint's `tpotSampleCount` is implicitly the TPOT subset of
   `sampleCount`.
4. **Three columns, all optional.** Adding three columns is a touch
   more schema cost than packing into one JSON blob, but it lets
   future SQL queries (p50 by provider, p95 by tag) hit the columns
   directly without JSON extraction. The `latency-stats.ts` helper
   keeps the percentile computation in one place so both stores
   stay bit-identical.
5. **Nearest-rank percentile, not linear interpolation.** Each
   reported p50/p95 is an observed value the operator can
   cross-reference in `recentCalls`. Linear interp would produce
   numbers that don't appear in any row, which is confusing for a
   small-N dashboard.
6. **`sampleCount` is the TTFT sample size.** TTFT is set whenever
   a stream emitted any bytes; TPOT requires usage. So
   `sampleCount` is the broader of the two, and the natural "did
   this window have data?" signal. If a future caller needs to
   distinguish "TTFT-only-windows" vs "TPOT-only-windows", add
   `tpotSampleCount` as a separate field rather than overloading
   the existing one.
7. **No `/metrics/latency` analogue for bucket=team/project/env.**
   The plan only spec'd per-token. Adding tag-bucket variants is
   cheap (mirror `topTagsBySpend`) but unmotivated until the
   prototype's waterfall renders per-tag. Defer to Phase 4.0
   feedback.
8. **`/metrics/latency` requires both `token` and `since`.** No
   default-window. The shorthand parser is reused from
   `/metrics/spend`, so the validation paths stay consistent
   (`missing_token`, `missing_since`, `invalid_since`).
9. **TTFT clamped to `>= 0`.** Localhost loopback can resolve faster
   than the calling tick; a `Date.now()` step could otherwise
   produce a `-1` artifact. The clamp is defensive only; in
   practice non-loopback upstreams will always have at least one
   millisecond of TTFT.

---

## Files of note

| File | What |
|---|---|
| `src/server.ts:counter` (the `Transform`) | TTFT capture point. Adding per-chunk timing later would extend `transform()` with an array of timestamps. |
| `src/server.ts:finalizeCallEntry` | The single audit-write seam — usage parse, latency derivation, cost reconciliation all happen here. |
| `src/latency-stats.ts` | `computeLatencyStats` and `percentile`. The whole percentile policy is one ~30 line module. |
| `src/store-sqlite.ts:latencyStatsByTokenSince` | The SQL is intentionally simple — project + filter, JS does the percentile. node:sqlite has no `percentile_cont`. |
| `tests/latency.test.ts` | Reference harness for any future provider with a custom streaming shape. |

---

## What to do next

Three reasonable next moves; user picks.

### Option A — Phase 3.8 (rotate-all + batch reissue)

The remaining backend ops piece. Plan flags it as "Kimi-fit" — adds
`token rotate-all`, `token reissue-batch`, `token rotate-all --preview`.
Backs the prototype's fire-drill UX with real ops. Doesn't touch the
proxy hot path. Well-shaped CLI work.

### Option B — Phase 4.0 prep (frontend scaffold)

With latency telemetry shipped, the prototype-to-real wire-up is now
worth doing. Vite + React 18, route per screen, Recharts for
waterfalls/forecasts. Mid-size effort; if you want to maintain wedge
velocity, leave for later and do 3.8 first.

### Option C — Wire `/metrics/latency` to the prototype

Quick, demo-able. The "Recent Activity" card already lists per-call
durations; add a "p50/p95 TTFT" badge sourced from the new endpoint.
Cheap proof the telemetry is end-to-end.

**Recommend A** — Phase 3.8. Closes out the 3.x roadmap and gives
the dashboard a real rotation-incident workflow to demo. The CLI
is the right level of abstraction for the work — `cli.ts` already
has `revoke-all --machine` as a precedent.

---

## Phase 3.7 smoke test the next instance can run

(Optional — unit + integration coverage is comprehensive, but a
manual smoke against a real upstream confirms the operator UX.)

```sh
# Streamed completion that returns usage:
keybroker token issue --provider openai --scope '*' \
  --max-calls 5 --label smoke-latency
# Use the brk_ token:
curl -X POST http://127.0.0.1:7843/openai/v1/chat/completions \
  -H "Authorization: Bearer $BRK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","stream":true,
        "stream_options":{"include_usage":true},
        "messages":[{"role":"user","content":"count to 5"}]}'
# Expected: streamed SSE response, then audit row carries ttft_ms,
# tpot_ms_avg, output_tokens.

# Then query the latency endpoint:
curl "http://127.0.0.1:7843/metrics/latency?token=<token_id>&since=1h"
# Expected: {"sampleCount":1,"p50TtftMs":<n>,"p95TtftMs":<n>,
#            "p50TpotMsAvg":<n>,"p95TpotMsAvg":<n>}.
```

---

## Stop-and-check-in triggers (carry forward)

- Before changing `ExtractorInput` again — touches every provider's
  extractor.
- Before adding any auto-kill behavior to the broker sidecar.
  Spawn-and-leave is deliberate.
- Before shipping the `policy.json` `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before
  any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in dispatcher's `keybroker.mjs`
  assumes the dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` —
  `Date.parse` is permissive enough to be a footgun; add deliberately
  and validate strictly.
- Before logging the matched secret substring ANYWHERE — the policy
  default is detector-name-only, and the invariant is asserted in
  tests. If you find yourself wanting the matched bytes for a "better
  debug message", DON'T. Add a separate ops-only counter keyed by
  detector name instead.
- Before adding a sixth built-in detector, ask whether it has a fixed
  prefix or shape. Generic-entropy / arbitrary-base64 patterns belong
  in Layer 3, not Layer 1 — they produce false positives in normal
  prompt content.
- Before flipping `scanner.enabled` to default-off, reread the Phase
  3.6 decision log. The default-on posture is load-bearing for the
  wedge story.
- Before adding a third `authStyle` literal, ask whether `"header"` +
  a different `authHeader` covers it.
- Before flipping `KEYBROKER_ROUTE` to default-on, smoke-test against
  real upstreams.
- **Phase 3.7 (active):** before adding per-chunk inter-arrival
  timings to the audit row, see decision 2 above. The schema
  intentionally stores per-call means; per-chunk samples would blow
  it up. If a chunk histogram is needed, add a separate
  retention-limited buffer, don't widen the audit row.
- **Phase 3.7 (active):** before reusing `firstByteAt` for any
  request-scoped logic OTHER than the audit row, remember the
  Transform's `transform()` runs OUTSIDE the request handler's
  closure timing. Moving the first-byte check into the request
  pipeline would change the semantic.

---

## Useful commands

```sh
# from keybroker
npx vitest run                                # 441 tests, ~27s
npx vitest run tests/latency.test.ts          # 11 latency tests
npm run typecheck                             # clean

# Inspect latency:
curl "http://127.0.0.1:7843/metrics/latency?token=<id>&since=24h"
```

---

## Final state

- One commit on `main`: schema migration + percentile helper + proxy
  capture + /metrics/latency endpoint + 11 tests + README.
  Push pending user authorization.
- 441 tests pass, typecheck clean.
- Phase 3.7 exit criteria met: real audit row shows non-zero
  `ttft_ms` and `tpot_ms_avg` for a streamed completion (assertion in
  `tests/latency.test.ts`). p50/p95 queryable via `/metrics/latency`.
- Plan file `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  Phase 3.7 scope shipped. Next phase per plan ordering: 3.8
  (rotate-all + reissue-batch).

Take your time.
