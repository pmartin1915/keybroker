# Handoff — keybroker Phase 3.2 progress (2026-05-10, mid-phase)

You are the next instance. This handoff covers in-flight Phase 3.2 work.
Phase 3.2 is **partial**: commits 1–3 shipped, commit 4 is blocked on a
gap discovered mid-execution.

---

## What's done

| Commit | Repo | Hash | Status |
|---|---|---|---|
| 3.2/1 — normalizeMachine port | dispatcher | `206014a` | pushed to origin/main |
| 3.2/3 — sidecar lifecycle | dispatcher | `2342fcb` | pushed to origin/main |
| 3.2/2 — /health extension | keybroker | `795ceee` | committed locally, **NOT pushed** (auto-mode classifier blocked the push despite explicit user approval; user can `git push origin main` from the keybroker dir manually) |

**Test status:**
- dispatcher: 761/761 (10 new in `keybroker.test.mjs`)
- keybroker: 93/93 store tests + 211 total (3 pre-existing Windows hook-timeout flakes — known)

---

## What was discovered (the blocker)

Commit 4 of Phase 3.2 was supposed to replace `Bearer ${apiKey}` at
`claude-budget-dispatcher/scripts/lib/provider.mjs:200` with
`Bearer ${brokerToken}`. **This cannot land yet.**

The dispatcher's `provider.mjs` calls 6 provider families:
**gemini, mistral, groq, openrouter, ollama, deepseek**.

`keybroker/src/providers/index.ts` registers exactly 3:
**openai, anthropic, echo**.

Routing a `Bearer ${brokerToken}` request to keybroker for any of the
dispatcher's actual providers returns `unknown_provider` — the broker
has no `/gemini/*` or `/mistral/*` route.

The Phase 3.0 scout report (`HANDOFF-2026-05-09-phase-3-0.md`) flagged
the bearer-replacement site but did not verify provider parity. That's
the gap.

---

## What to do next

### Option A (recommended): Phase 3.2.5 — extend keybroker providers

Add `gemini` and `mistral` ProviderSpec entries before commit 4. Plan
file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`
section "Phase 3.2.5" has full scope, but key beats:

1. **Mistral is easy.** `https://api.mistral.ai`, OpenAI-compat
   `/v1/chat/completions`, Bearer auth. Use existing
   `jsonRequestMetadata`. ~30 min.
2. **Gemini is gnarly.** Auth is `x-goog-api-key` header, not Bearer —
   need a third `authStyle` variant in `ProviderSpec`. Worse: model is
   in the **URL path** (`/v1beta/models/<model>:generateContent`), not
   the body. The current `extractRequestMetadata(body)` signature
   doesn't have access to the path. Either:
   - Change the signature to `(body, path)` (touches openai/anthropic
     callers — small).
   - Or add a separate `extractModelFromPath(path)` field on
     ProviderSpec (cleaner, parallel surface).

Either way, this design choice ripples into Phase 3.6 (scanner) since
the scanner inspects the body too. Surface it before committing.

### Option B: skip to Phase 3.3 (token tags)

Phase 3.3 (add `tags: { team, project, env }` to JWT) is independent
and unblocks 3.4–3.8. Defer 3.2.5 + commit 4 indefinitely if the
dispatcher integration's marginal value is lower than the FinOps
pipeline's.

This is cheaper but leaves the dispatcher with direct API keys for
gemini/mistral indefinitely, which means broker telemetry has only
synthetic test traffic. Not great for proving the wedge.

---

## Files you should know about (in addition to the prior handoff)

| File | Role |
|---|---|
| `claude-budget-dispatcher/scripts/lib/keybroker.mjs` | New: sidecar lifecycle helper (ensureBrokerRunning, readBrokerHealth, readPidFile) |
| `claude-budget-dispatcher/scripts/lib/hostname.mjs` | New: normalizeMachine port (verbatim mirror of `keybroker/src/hostname.ts`) |
| `claude-budget-dispatcher/scripts/lib/health.mjs:339` | `writeHealthFile` now accepts `extraFields` (4th arg) so callers can inject `keybroker_ok` |
| `claude-budget-dispatcher/scripts/dispatch.mjs:386-405` | broker-spawn block; fail-soft, runs after gates pass |
| `keybroker/src/server.ts:39-58` | `/health` now returns `keybroker_ok`, `last24hSpendUsdByMachine` |
| `keybroker/src/store-types.ts:103-110` | New `sumCostUsdByMachineSince` interface method |

---

## Stop-and-check-in triggers (carry forward)

- Before changing the `ProviderSpec.extractRequestMetadata` signature in
  Phase 3.2.5 — that ripples into Phase 3.6 scanner design.
- Before adding any auto-kill behavior to the broker sidecar. Current
  posture is spawn-and-leave deliberately (avoids the orphaned-process
  thrash flagged 2026-05-08).
- Before publishing keybroker to npm or anywhere outside `~/DevProjects`.
  The hardcoded `KEYBROKER_BIN` default in `keybroker.mjs` assumes the
  dev path.

---

## Useful commands

```sh
# from keybroker
git push origin main                          # if commit 795ceee still needs pushing
npx vitest run tests/store.test.ts            # 93 store tests
npm run typecheck                             # tsc --noEmit

# from dispatcher
npm test                                      # 761 tests
node --test scripts/lib/__tests__/keybroker.test.mjs  # 10 sidecar tests

# manual sidecar smoke test
KEYBROKER_BIN="C:/Users/perry/DevProjects/keybroker/dist/cli.js" \
  node scripts/dispatch.mjs --dry-run
```

---

## Final state

- Dispatcher commits 1 + 3 pushed to origin/main.
- Keybroker commit 2 committed locally only (push blocked).
- Phase 3.2 plan file marked partial; Phase 3.2.5 inserted as the
  unblocking step for commit 4.
- Plan file at `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md`.

Take your time.
