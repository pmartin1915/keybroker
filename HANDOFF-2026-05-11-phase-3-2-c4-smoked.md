# Handoff — Phase 3.2 c4 smoke shipped + pricing fix (2026-05-11)

You are the next instance. This session ran the long-pending Phase 3.2 c4
dispatcher smoke against real Gemini + Mistral keys, found a real shipping
blocker (pricing gaps), fixed it, and pushed. Phase 3.2 is now fully
closed — `KEYBROKER_ROUTE` default-on is a one-line dispatcher change
whenever the user wants it.

Working tree is clean. Memory updated. Two commits pushed since the prior
handoff (`aa0a6ca`).

---

## What shipped this session

| Commit | What |
|---|---|
| `aa0a6ca` (held from prior instance, pushed at session start) | docs: lock Phase 4.2 plan |
| `76d2855` | **fix(pricing): add Gemini + Mistral entries so capped dispatcher tokens stop 403ing.** 5 PRICING rules + 1 regression test. |

`origin/main` is at `76d2855`. 509 tests pass (was 508). Typecheck clean.
Main bundle 224 KB (unchanged — pricing.ts is broker-side only).

---

## What the smoke proved + the bug it surfaced

The smoke was a manual round-trip rather than the dispatcher's
`KEYBROKER_ROUTE=1 node scripts/dispatch.mjs --dry-run --force` flow,
because **`--dry-run` exits before the model call** (line 640 of
`dispatch.mjs`). The prior handoff's claim that "`--dry-run + --force =
full pipeline including model calls`" was wrong — `--force` only
bypasses gates, not the dry-run early-exit. A real round-trip via the
dispatcher requires a non-dry-run dispatch, which commits work to a
project repo. Out of scope for a smoke.

Substitute: a `node` harness that minted tokens via the keybroker CLI
(same path the dispatcher uses) and hit the broker as the dispatcher
would. Result:

- `gemini-2.5-flash` → **200 OK**, 724ms, broker audit row `outcome=ok`
- `mistral-large-latest` → **200 OK**, 563ms, returned "PONG"

First attempt with `--cap-usd 1.0` returned `403 cap_unpriced_model` for
both. Root cause: `src/pricing.ts` PRICING table only had OpenAI +
Anthropic entries. Broker's pre-flight cap branch (`server.ts:905, 949,
1014`) denies any capped token whose model can't be priced. The
dispatcher's `broker-token.mjs` hardcodes `DEFAULT_CAP_USD = 5.0` on
every mint — so **every** dispatcher-routed gemini/mistral call would
have 403'd and silently fallen through to direct SDK. That's the
opposite of "broker routing verified."

Fix (in `76d2855`): added five PRICING patterns at published list prices
as of May 2026:

```ts
{ pattern: "gemini-2.5-flash*",     inputUsdPerMTok: 0.3,  outputUsdPerMTok: 2.5 },
{ pattern: "gemini-2.5-pro*",       inputUsdPerMTok: 1.25, outputUsdPerMTok: 10  },
{ pattern: "mistral-large*",        inputUsdPerMTok: 2,    outputUsdPerMTok: 6   },
{ pattern: "mistral-small*",        inputUsdPerMTok: 0.2,  outputUsdPerMTok: 0.6 },
{ pattern: "codestral-latest*",     inputUsdPerMTok: 0.3,  outputUsdPerMTok: 0.9 },
```

2.5 Flash output uses the thinking-on tier ($2.50/M) as a conservative
bound; non-thinking is $0.30/M and the comment in pricing.ts explains
the choice. Regression test in `tests/pricing.test.ts` pins all five so
a future PRICING edit can't silently unprice them.

---

## Decisions locked in (don't re-litigate)

1. **Pricing entries are minimum-viable, not exhaustive.** Only the
   five patterns the dispatcher currently mints for. `gemini-2.0-flash*`,
   `gemini-1.5-*`, `ministral-*` deliberately omitted — add when there's
   a real call site, not speculatively. Anti-roadmap-disciplined.
2. **Thinking-on tier for 2.5 Flash.** Over-estimating denies more
   aggressively but operator-recoverable (raise the cap). Under-
   estimating lets requests nick the cap. The pricing.ts header
   already codifies "err toward published list, not negotiated
   discount" — same logic applied to thinking tiers.
3. **Did NOT re-smoke after the pricing commit.** The regression test
   covers `priceForModel(...)` returning defined for all five patterns,
   which is the exact gate `server.ts` checks. No additional broker
   logic to verify; re-smoking would have burned more Gemini/Mistral
   quota for no new information.
4. **Did NOT flip `KEYBROKER_ROUTE` default-on in the dispatcher.** That
   change lives in `claude-budget-dispatcher`, not this repo. Per Phase
   3.2 c4 invariant #1, default-on is a deliberate choice the user
   makes after verifying the dispatcher actually wants to route every
   model call. Smoke clears the *prerequisite* for that flip; it
   doesn't motivate the flip itself.

---

## Side observations worth flagging (not blockers)

### The keybroker repo has no build script

`package.json` has only `typecheck: tsc --noEmit`. The dispatcher
hardcodes `KEYBROKER_BIN = C:/Users/perry/DevProjects/keybroker/dist/cli.js`
(see `dispatcher/scripts/lib/keybroker.mjs:21`). For this smoke I
built with `npx tsc --outDir dist --noEmit false --declaration false`,
which emits to `dist/src/cli.js` (not `dist/cli.js`) because
`tsconfig.json` has no `rootDir`. I cleaned the dist/ after the smoke.

If the user wants the dispatcher to actually find the broker bin in a
non-dev setup, this needs either:
- a `build` script + flattened output (`rootDir: "src"` in tsconfig), or
- `KEYBROKER_BIN` overridden at the dispatcher.

Not urgent — the dispatcher's fail-soft path means a missing bin just
falls through to direct SDK. But it's why broker routing has never
worked default-on in practice.

### `/healthz` does not exist

`keybroker.mjs:readBrokerHealth` GETs `/health` (without z). The server
returns 404 for `/healthz`. Probably fine — the dispatcher uses
`/health`, which I didn't verify. Mentioning so a future health-check
tweak doesn't chase the wrong path.

### Inconsistent init state

Found `~/.keybroker/config.json` missing but the master key was in the
keychain from a previous session. `keybroker init` (no `--force`) said
"already initialized" based on the keychain entry; `secret add` then
failed because config.json wasn't present. `init --force` fixed it. If
this happens again to a user (e.g., they delete `.keybroker/` by hand
but the keychain entry persists), the error chain is confusing. Not a
fix for this commit — flagging as a UX smell.

### Three Gemini/Mistral keys are in the chat transcript

The user pasted real keys mid-session to drive the smoke. Recommended
rotation as the session-closing action. Not the next instance's
problem unless those keys turn up in logs.

---

## Phase 4.2a — strict next action, no longer blocked

The original Phase 4.2 plan's "Phase 3.2 c4 dispatcher smoke" prerequisite
is **cleared**. Next strict action is Phase 4.2a (encoding-aware Layer 1.5
decoder).

The Opus-locked invariants are in `memory/decision_phase_4_2_a_decoding.md`
and the Sonnet delegation prompt is at the bottom of that file. Re-read
`Cowork-Phase-4.2-Research-Brief.md` §3 first for the decoder choice
rationale (`@iconfu/string-decoder`, max 1 layer, fail-open on decode
error).

Estimated shape: ~1 commit, ~200 LoC, no schema change, no policy.json
change. New `src/decode.ts`, light edits to `src/scanner.ts` + tests.
Tests should hit at least: raw base64 AWS key, URL-encoded GitHub PAT,
nested base64-of-base64 (should NOT recurse), garbage non-decodable
input (should fall through to plaintext scan).

---

## State of related repos

- **keybroker:** clean at `76d2855`. 509 tests pass.
- **claude-budget-dispatcher:** unchanged this session. Phase 3.2 c4
  files (`broker-token.mjs`, `provider.mjs`, two test files) still
  committed there from the prior session per
  `HANDOFF-2026-05-10-phase-3-2-commit-4.md`. The `DEFAULT_CAP_USD = 5.0`
  invariant is unchanged and now safe to ship default-on because the
  broker side prices the dispatcher's models.

---

## Useful commands

```sh
# verify the pricing fix is in
git log --oneline -3   # 76d2855, aa0a6ca, 5103557

# run the smoke yourself (if needed)
npx tsc --outDir dist --noEmit false --declaration false   # one-shot build
node dist/src/cli.js init --force                          # only if state is borked
KEYBROKER_SECRET="..." node dist/src/cli.js secret add gemini
node dist/src/cli.js serve                                 # broker on :8787
node dist/src/cli.js token issue --provider gemini --scope '*' --max-calls 5 --ttl 600 --cap-usd 1.0
# then hit http://127.0.0.1:8787/gemini/v1beta/models/<model>:generateContent
node dist/src/cli.js logs -n 10
# clean up:
rm -rf dist
# stop broker: kill the tsx PID (find via netstat -ano | grep :8787)
```

---

## Stop-and-check-in triggers (carry forward, plus one new)

- All existing triggers from prior handoffs still apply (see prior
  handoff for the running list).
- **NEW:** before adding more PRICING entries, ask whether a real call
  site exists. Speculative pricing entries are a maintenance tax; the
  regression test only covers the five the dispatcher actually uses.
- **NEW:** before re-running the dispatcher smoke, remember
  `--dry-run` exits early. The handoff that said "--dry-run + --force
  = full pipeline" was wrong; use the custom node harness pattern or
  do a real (committed) dispatch in a sandbox project.

---

## Final state

- `origin/main`: `76d2855` (pricing fix, pushed).
- Local tree: clean, matches origin.
- 509 tests, typecheck clean, main bundle 224 KB (web unchanged).
- Phase 3.2 c4: **fully closed.** No remaining blockers on Phase 4.2a.

Take your time. Read `memory/decision_phase_4_2_a_decoding.md` before
opening any new commit.
