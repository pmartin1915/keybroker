# Handoff — keybroker Phase 3.2 commit 4 implemented (2026-05-10)

You are the next instance. Phase 3.2 commit 4 — "Gemini + Mistral routed
through broker" — is **code-complete and tested in the dispatcher repo,
not yet committed**. The work landed in `claude-budget-dispatcher`, not
this repo: keybroker itself is unchanged from `eb738f7` (the Phase 3.2.5
post-push state). The two repos cross-reference cleanly.

The dispatcher work is uncommitted on the working tree (see "Files
changed" below). Whether to commit + push is a user call — the user
hadn't explicitly authorized a commit in the dispatcher repo for this
session. Smoke test (real Gemini/Mistral keys) is also pending.

---

## What landed (in `claude-budget-dispatcher`)

| File | Change |
|---|---|
| `scripts/lib/broker-token.mjs` (new) | Mints + caches keybroker JWTs per provider via `keybroker token issue` CLI. Module-level Map, `_resetBrokerTokenCacheForTests` exported. Lazy on first call; `false` sentinel cached on any failure so a missing/broken broker doesn't re-spawn the CLI every model call. Reads broker URL/bin from `keybroker.mjs` to avoid duplicating env resolution. |
| `scripts/lib/provider.mjs` | `callProvider`'s gemini + mistral cases now check `getBrokerToken(...)` first. If a token is returned, route via fetch to `${KEYBROKER_URL}/<provider>/...` with `Authorization: Bearer <jwt>`; native Gemini body shape for gemini, OpenAI-compat for mistral. Null token → existing SDK path unchanged (including the gemini billed-key fallback). |
| `scripts/lib/__tests__/broker-token.test.mjs` (new) | 11 tests: env gating, cache hit, separate-per-provider caching, arg shape, JWT extraction, all three failure modes (non-zero exit, empty stdout, spawn throws). All inject a stub spawn — no real CLI shelled. |
| `scripts/lib/__tests__/provider-broker.test.mjs` (new) | 7 tests: a tiny `http.createServer` plays the broker; verifies URL, method, headers, body shape for both providers; broker error propagates; empty candidates → `""`; KEYBROKER_ROUTE unset / mint failure both fall through to SDK. |

**Tests:** `node --test scripts/lib/__tests__/*.test.mjs` → 825 pass / 189 suites (was 807 → +18 across the two new files).

---

## Decisions locked in (don't re-litigate)

1. **Opt-in via `KEYBROKER_ROUTE=1`, off by default.** The dispatcher
   already spawns the broker via `ensureBrokerRunning` (Phase 3.2
   commit 3), but routes traffic through it only when this env var is
   set. Rationale: lets the user verify broker round-trip end-to-end
   in a controlled run before flipping the default. Switching to
   default-on is a one-line change later — no code restructure.
2. **In-memory cache only.** Tokens never hit disk. The cache is a
   module-level Map cleared by `_resetBrokerTokenCacheForTests`. One
   token per provider per dispatch process. Survives only for the
   process lifetime, matching the plan's "Cache in-memory only — never
   write to disk."
3. **`false` sentinel on mint failure.** Avoids re-spawning
   `keybroker token issue` on every single model call when the broker
   is misconfigured. Trades freshness (one minted token lasts the
   whole dispatch run) for survivability. If a token expires mid-run,
   the next call gets a 401 from the broker and that error propagates
   — we don't auto-retry. TTL default is 30 min; one dispatch run is
   well under that.
4. **Default token shape: `--scope '*' --max-calls 200 --ttl 1800
   --cap-usd 5.0`.** Sized for a single dispatch run (worker.mjs makes
   maybe 5–20 calls per run). Cap is per-token, not global. No
   `--model` flag so the same token works across all gemini/mistral
   models in a run.
5. **Fall-through to SDK when broker token unavailable.** Whether the
   reason is "routing disabled" or "mint failed", `callProvider`'s
   gemini/mistral cases drop into the existing SDK path unchanged.
   This includes the Gemini billed-key fallback (`geminiBilled`) — if
   the broker isn't routing, that path is preserved. If the broker IS
   routing, the billed-key fallback is bypassed because we go through
   the broker first; that's intentional, the broker's `secret add
   gemini` selects which upstream key to use.
6. **Native Gemini body shape for the broker call.** Body is
   `{contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:
   0.2, maxOutputTokens:8000}}` — NOT OpenAI-compat. The broker's
   `geminiRequestMetadata` extractor pulls `model` from the URL and
   `maxOutputTokens` from this exact path. Body shape must match.
7. **Mistral reuses `callOpenAICompat`.** The Mistral HTTP surface is
   OpenAI-compatible, so the broker call is just `callOpenAICompat`
   with the broker base URL + a broker JWT in place of `apiKey`. One
   helper, no duplication.
8. **`URL`-encoded model name in the gemini path.** `encodeURIComponent`
   on the model name in `callGeminiViaBroker`. Today all gemini model
   names are URL-safe, but the encoder is a cheap safety net for
   future names with colons or dots in unexpected places.
9. **No threading of `brokerCtx` through worker.mjs.** I considered
   adding a parameter through `callProvider → callModelThrottled →
   callModelWithFallback → 8 call sites`. Rejected: too invasive for
   what's effectively a side-channel (the broker URL + JWT). Module-
   level singleton via `getBrokerToken` keeps the change local to
   provider.mjs.

---

## Files of note

| File | What |
|---|---|
| `claude-budget-dispatcher/scripts/lib/broker-token.mjs` | Sole owner of broker-token lifecycle. If TTL/max-calls/cap need to come from `budget.json` later, this is the one file to change. |
| `claude-budget-dispatcher/scripts/lib/provider.mjs:103` | gemini broker branch + SDK fallback. |
| `claude-budget-dispatcher/scripts/lib/provider.mjs:156` | mistral broker branch + SDK fallback. |
| `claude-budget-dispatcher/scripts/lib/provider.mjs:185+` | `callGeminiViaBroker` and `callMistralViaBroker` helpers — body shapes live here. |
| `keybroker/src/providers/index.ts:GEMINI_GENERATE_PATH` | If this regex changes, the dispatcher's gemini URL builder needs to match. The new test `provider-broker.test.mjs` asserts the URL shape, so a mismatch will fail loudly. |

---

## Smoke test the next instance should run

Real round-trip via dispatcher → broker → upstream. Prerequisites: the
broker must have real upstream keys stored.

```sh
# In keybroker repo:
KEYBROKER_SECRET='<real-gemini-key>'  keybroker secret add gemini
KEYBROKER_SECRET='<real-mistral-key>' keybroker secret add mistral
keybroker serve                      # broker on :7843 (or let dispatcher spawn it)

# In dispatcher repo:
KEYBROKER_ROUTE=1 node scripts/dispatch.mjs --dry-run --force
#   ^ flag flips broker routing on
#   --dry-run + --force = full pipeline including model calls, no commit

# Verify:
keybroker logs --since 5m            # should show gemini + mistral rows
                                      #   outcome=ok, machine=<your-machine>,
                                      #   model=gemini-2.5-flash etc.
```

If `logs` shows the rows with `outcome: ok`, Phase 3.2 is complete
end-to-end. If they show `outcome: scope_denied` or `model_denied`,
the token's scope/models were over-restricted — bump the broker-token
defaults in `broker-token.mjs:DEFAULT_MAX_CALLS` etc.

---

## What's NOT done

- **Not committed.** The four files are still on the working tree of
  the dispatcher repo. Run `git status` in
  `claude-budget-dispatcher` and decide commit shape. Suggested:
  one commit, scope `feat(dispatcher,provider)`, message
  "route gemini + mistral via keybroker (Phase 3.2 commit 4)".
- **Not smoke-tested with real keys.** Unit tests cover URL/body/auth
  shape; the actual upstream round-trip is the only thing that proves
  the broker proxy and dispatcher agree on the wire.
- **groq / openrouter / ollama / deepseek not routed.** Plan note
  Phase 3.2 commit 4: "groq/openrouter/ollama/deepseek can land as
  fast-followers since the dispatcher uses them only as fallbacks."
  These still talk direct via `callOpenAICompat`. To bring them under
  the broker, keybroker would need ProviderSpec entries for each
  (Phase 3.2.5-style addition). That's a fast-follow when motivated;
  the current four-provider gap doesn't block Phase 3.3+ work.
- **`KEYBROKER_ROUTE` is the only knob.** No per-provider opt-out,
  no `budget.json` config. If a user wants only gemini routed
  (not mistral), they'd have to edit `provider.mjs`. Not worth
  generalizing until there's a use case.

---

## What to do next

### Option A — Smoke + commit the dispatcher work

Run the smoke test above with real keys. If green, commit + push the
four dispatcher files. Updates the keybroker `HANDOFF-*.md` to mark
Phase 3.2 fully shipped. ~30 min of work.

### Option B — Phase 3.6 (inline secret scanning)

The headline differentiator from the plan. The deep-research prompt is
at `Claude-Deep-Research-Prompt.md` (this repo). With Phase 3.2 done
end-to-end (modulo smoke), the scanner has a real path to test
against: dispatcher sends a prompt with an embedded fake AWS key, the
broker blocks it, audit row shows `egress_blocked`. The Phase 3.2.5
`ExtractorInput` shape was deliberately widened to make this plug in
cleanly — see decision #1 in `HANDOFF-2026-05-10-phase-3-2-5.md`.

### Option C — Phase 3.3 (token tags)

Foundational schema change. Larger blast radius (5+ files). Unblocks
Phase 4's prototype-to-real wire-up of the team/project rollup cards.
The deep-research prompt for 3.6 is already drafted; 3.3 has no
parallel research dependency.

**Recommend A** — close out Phase 3.2 fully before opening a new
phase. The smoke test is the single concrete way to know the routing
actually works against real upstreams, and the work is sitting in an
uncommitted state right now.

---

## Stop-and-check-in triggers (carry forward unchanged)

- Before changing `ExtractorInput` again (e.g. adding `headers` for
  Phase 3.6's scanner) — touches every provider's extractor.
- Before adding any auto-kill behavior to the broker sidecar. Spawn-
  and-leave is deliberate.
- Before shipping the `policy.json` `tag_allowlist` strict variant
  (the rejected option) — would force editing policy.json before any
  new tag value can be used. Hybrid is a deliberate choice.
- Before publishing to npm or anywhere outside `~/DevProjects` —
  hardcoded `KEYBROKER_BIN` default in `keybroker.mjs` assumes the
  dev path.
- Before adding ISO-timestamp support to `parseSinceShorthand` —
  `Date.parse` is permissive enough to be a footgun; add deliberately
  and validate strictly.
- **Phase 3.6:** before logging matched secret substrings anywhere —
  policy default is detector-name-only.
- **Phase 3.2.5:** before adding a third `authStyle` literal, ask
  whether the new provider really needs one or whether `authStyle:
  "header"` + a different `authHeader` covers it.
- **NEW (Phase 3.2 commit 4):** before flipping `KEYBROKER_ROUTE` to
  default-on, smoke-test against real upstreams. The opt-in gate
  exists specifically to keep the broker from breaking the dispatcher
  on a misconfigured machine.
- **NEW (Phase 3.2 commit 4):** before threading `brokerCtx` through
  `callProvider`'s call sites, reconsider — the module-level
  singleton was a deliberate choice to keep the diff small. If you
  find yourself wanting per-call context (a different machine per
  request, say), surface that constraint first.

---

## Useful commands

```sh
# keybroker (unchanged this commit)
npx vitest run                                 # 395 tests
npm run typecheck                              # clean

# dispatcher (the four new/modified files)
cd ../claude-budget-dispatcher
node --test scripts/lib/__tests__/broker-token.test.mjs
node --test scripts/lib/__tests__/provider-broker.test.mjs
node --test scripts/lib/__tests__/*.test.mjs   # full lib suite, 825 tests

# end-to-end smoke (real keys, see "Smoke test" section)
KEYBROKER_ROUTE=1 node scripts/dispatch.mjs --dry-run --force
```

---

## Final state

- keybroker repo: clean at `eb738f7` (no changes this turn).
- dispatcher repo: 4 files uncommitted on `main`. Tests green.
  - `M  scripts/lib/provider.mjs`
  - `??  scripts/lib/broker-token.mjs`
  - `??  scripts/lib/__tests__/broker-token.test.mjs`
  - `??  scripts/lib/__tests__/provider-broker.test.mjs`
- 825 dispatcher tests pass (+18 from Phase 3.2 commit 4).
- Phase 3.2 commit 4 exit criteria: code path exists, unit-covered,
  fail-soft on broker absence, opt-in by env. End-to-end with real
  upstreams: pending (smoke section above).
- Plan file `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`:
  Phase 3.2 commit 4 line still reads "BLOCKED" — should be flipped
  to "done (smoke pending)" by the next instance once smoked.

Take your time.
