# Handoff — keybroker Phase 3.2.5 complete (2026-05-10)

You are the next instance. Phase 3.2.5 (gemini + mistral providers)
shipped. Working tree clean once the commit lands. Phase 3.2 commit 4
is now unblocked.

Phase 3.5 (burn forecast) shipped earlier the same day on `4e3dd32`.
See `HANDOFF-2026-05-10-phase-3-5.md` for that context.

---

## What landed

| Layer | File | Change |
|---|---|---|
| Provider abstraction | `src/providers/index.ts` | New `ExtractorInput` interface. `extractRequestMetadata` widened from `(body) => Extraction` to `(req: {body, path, method}) => Extraction`. `authStyle` literal renamed `"x-api-key"` → `"header"` so it covers any `<header-name>: <raw-key>` provider. New `geminiRequestMetadata` extractor parses model from path. New `gemini` + `mistral` entries in `PROVIDERS`. |
| Server | `src/server.ts:335` | Call site updated to pass `{body, path: upstreamPath, method: req.method}`. No behavior change for openai/anthropic/echo; gemini now gets the path it needs. |
| Anthropic | `src/providers/index.ts` | `authStyle` flipped from `"x-api-key"` to `"header"` (same effective behavior; `authHeader: "x-api-key"` remains). |
| Tests | `tests/providers.test.ts` (new) | 20 tests: registry shape, auth-style assertions per provider, jsonRequestMetadata (4 kinds + max_completion_tokens precedence + mistral parity + path-method ignored), geminiRequestMetadata (no-body, model-from-path, stream-action detection, maxOutputTokens, no-model when path doesn't match, unparseable-body fail-closed, tuned-model `publishers/google/models/...` path shape). |
| Docs | `README.md` "Adding a provider" | Replaced the hypothetical mistral example (now built-in) with a groq snippet; documented `authStyle: "header"` for `x-*-api-key` styles and the gemini path-extractor pattern. |

**Tests:** 395 pass / 16 files (was 375 → +20 across Phase 3.2.5).
**`npm run typecheck`:** clean.

---

## Decisions locked in (don't re-litigate)

1. **Extractor signature is an object, not positional args.** The new
   `ExtractorInput = { body, path, method }` is what providers receive.
   Object args are forward-compatible with Phase 3.6's scanner, which
   will plug into the same shape (likely via a sibling `scanRequest?:
   (req) => ScanResult` method). The previous positional `(body) =>`
   would have forced two reshape passes — one for gemini, another for
   the scanner. We did it once.
2. **`authStyle: "header"` replaces `"x-api-key"`.** The literal value
   "x-api-key" was already overridable via `authHeader`, so the name
   was lying. "header" is honest: bearer-vs-named-header is the actual
   binary. Anthropic's `authHeader: "x-api-key"` remains the same
   string, just under the new style.
3. **Gemini path extractor regex tolerates intermediate segments.**
   `/v1beta(?:\/[^/]+)*?\/models\/([^/:]+):([A-Za-z][A-Za-z0-9]*)/`
   matches both `/v1beta/models/<name>:<action>` (base models) and
   `/v1beta/publishers/google/models/<name>:<action>` (tuned/published
   models). Tested.
4. **Gemini fail-closed on unparseable body even when path has model.**
   `geminiRequestMetadata` parses the body first and short-circuits
   to `unparseable` on JSON error. Mirrors the OpenAI/Anthropic
   posture: a malformed body on an `mdl`-restricted token must not
   ride through just because the path looks right.
5. **Gemini `stream` is derived from the path action suffix.**
   `:generateContent` → `stream: false`, `:streamGenerateContent` →
   `stream: true`. This matches Gemini's REST surface — there is no
   `stream` field in the body. Generic `^stream` prefix match keeps
   future action names (`:streamAnswer` etc) working without code
   changes.
6. **Gemini `maxTokens` comes from `generationConfig.maxOutputTokens`.**
   Not `max_tokens`. Validated as finite + non-negative; non-numeric
   values silently omitted (extraction still returns `ok`). Same
   posture as the OpenAI extractor — extractor doesn't fail just
   because a single optional field is malformed.
7. **No CLI changes needed.** `getProvider(name)` is the only gate
   for `secret add` and `token issue`; adding `gemini`/`mistral` to
   `PROVIDERS` opens both commands automatically. Hint text in
   `secret add` already enumerates `Object.keys(PROVIDERS)`.
8. **No new tests for server-level proxy behavior on gemini.** The
   proxy test harness uses a single echo upstream; wiring a separate
   Gemini-shaped mock would duplicate `proxy.test.ts` for zero new
   coverage. The provider-level tests cover the extraction logic; the
   end-to-end smoke is the dispatcher itself (Phase 3.2 commit 4).
9. **Anthropic switched from `"x-api-key"` to `"header"` literal.** No
   runtime change — the `else` branch in `server.ts:558-560` already
   read `authHeader ?? "x-api-key"`. The rename is type-level only.
   No keys to migrate, no config to update.

---

## Files of note

| File | What |
|---|---|
| `src/providers/index.ts:GEMINI_GENERATE_PATH` | The path regex. If a future Gemini API version moves the model elsewhere, this is the single point of edit. |
| `src/providers/index.ts:geminiRequestMetadata` | Body-parse-first ordering matters for fail-closed posture (see decision #4). |
| `src/server.ts:335` | Sole call site. If a future provider needs more context (e.g. headers for the scanner), widen `ExtractorInput` and update this line. |
| `tests/providers.test.ts` | Has the tuned-model path test (`publishers/google/models/...`). If Gemini changes URL shape, that test will catch it. |

---

## Phase 3.2 commit 4 is now unblocked

The plan's Phase 3.2 commit 4 narrowed scope: "Gemini + Mistral routed
through broker." Both providers now exist. The dispatcher's
`provider.mjs:200` `Bearer ${apiKey}` replacement can land — for
gemini, the broker's outbound auth handling at `src/server.ts:556-560`
will correctly emit `x-goog-api-key: <real-key>` to upstream when the
dispatcher proxies through `/gemini/v1beta/models/<model>:generateContent`.

Smoke check the next instance should run:
```sh
# 1. Have a real Gemini API key handy.
KEYBROKER_SECRET='<real-key>' keybroker secret add gemini
keybroker token issue --provider gemini --scope '*' \
  --max-calls 5 --ttl 600 --label gemini-smoke \
  --model gemini-2.5-pro
# 2. Use the brk_... token to call:
curl 'http://127.0.0.1:7843/gemini/v1beta/models/gemini-2.5-pro:generateContent' \
  -H "Authorization: Bearer $BRK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"hello"}]}]}'
# 3. Verify the audit row records model=gemini-2.5-pro, outcome=ok.
```

If that round-trips, Phase 3.2 commit 4 is shippable.

---

## What to do next

Three reasonable next moves; user picks.

### Option A — Phase 3.2 commit 4 (close out 3.2)

Land the dispatcher's `Bearer ${brokerToken}` replacement now that
gemini+mistral exist. This is the original blocker, now unblocked.
Per the plan: "narrows to 'Gemini + Mistral routed through broker'
once those providers exist; groq/openrouter/ollama/deepseek can land
as fast-followers." Smallest blast radius of the three options.

### Option B — Phase 3.6 (inline secret scanning)

The headline wedge. With the new `ExtractorInput` shape, the scanner
can plug in as either:
- a sibling `ProviderSpec.scanRequest?: (req) => ScanResult` method,
  per-provider opt-out for non-LLM paths; or
- a standalone module called from `server.ts` between body buffering
  and the model gate.

Decision-point for the next instance: scanner-as-method (uniform
shape, per-provider override possible) vs scanner-as-module (one
implementation, runs for every provider that has a body). The plan
doesn't pre-commit, but lines up the trap: see
`trap_body_reserialization.md`.

### Option C — Phase 3.3 (token tags)

Foundational schema change. Without tags, the prototype's "Spend by
Team / Project" cards stay synthetic. The plan calls out 3.3 as the
prereq for the prototype-to-real wire-up in Phase 4. Larger blast
radius (5+ files), but unblocks downstream phases.

**Recommend A** — close the original blocker first, ship Phase 3.2
end-to-end through the dispatcher. Phase 3.6 and Phase 3.3 are both
fresh starts that benefit from a real dispatcher round-trip already
in place.

---

## Stop-and-check-in triggers (carry forward)

- Before changing `ExtractorInput` again (e.g. adding `headers`
  for Phase 3.6's scanner) — touches every provider's extractor.
- Before adding any auto-kill behavior to the broker sidecar.
  Spawn-and-leave is deliberate.
- Before shipping the policy.json `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before
  any new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in dispatcher's `keybroker.mjs`
  assumes the dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` —
  `Date.parse` is permissive enough to be a footgun; add deliberately
  and validate strictly.
- **Phase 3.6:** before logging matched secret substrings anywhere —
  the policy default is detector-name-only. The matched substring is
  the literal secret you're trying to keep out of logs.
- **NEW (Phase 3.2.5):** before adding a third `authStyle` literal,
  ask whether the new provider really needs one or whether
  `authStyle: "header"` + a different `authHeader` covers it. The
  rename collapsed an unnecessary axis; don't re-introduce it.

---

## Useful commands

```sh
# from keybroker
git log --oneline -5                       # tip
npx vitest run                             # 395 tests, ~21s on retry
npm run typecheck                          # clean

# provider-level test only:
npx vitest run tests/providers.test.ts
```

---

## Final state

- Working tree carries Phase 3.2.5 changes; commit it.
- 395 tests green, typecheck clean.
- Phase 3.2.5 exit criteria met: `keybroker secret add gemini` accepts
  the provider name; `keybroker token issue --provider gemini --model
  gemini-2.5-pro` succeeds (CLI doesn't reject because gemini has
  `extractRequestMetadata`); routes `/gemini/*` and `/mistral/*`
  resolve in `getProvider`. End-to-end smoke (real upstream) is the
  Phase 3.2 commit-4 follow-up.
- Plan file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
  unchanged — Phase 3.2.5 spec there matches what shipped.

Take your time.
