# Handoff — 2026-05-14 — post Path-A fixes

You're picking up after Path A (build pipeline, `c22e21c`) and a one-commit Dependabot patch (`e631810`).

## What landed today

- `c22e21c` — esbuild transpile-only build → `dist/cli.js`. `npm run build` produces 24 files in ~155ms. Unblocks the dispatcher's `KEYBROKER_ROUTE=1` path.
- `e631810` — `web/` vite 5.4.11 → 6.4.2 (pulls esbuild 0.21.5 → 0.25.12 transitively). Closes the two moderate Dependabot alerts that surfaced on `c22e21c`'s push. Web build, root build, typecheck, and the 630-test suite all verified green.

## Outstanding from the original three-item list

The previous instance (the one that shipped Path A) named three follow-ups in the closing message, but the message tail was truncated by `/clear` so the operator couldn't recover them. Best reconstruction below — verify against operator memory if they're around.

### 1. Hoist broker defaults from dispatcher into `budget.json` (BEST GUESS — confirm before doing)

> **RESOLVED 2026-05-16:** already shipped in dispatcher commit `2279be8`
> (`feat(broker-token): config-driven cap/ttl/max-calls`) the same afternoon this
> handoff was written. `broker-token.mjs` reads `cfg.keybroker` via `loadConfig()`
> with the hardcoded constants as floor and per-call opts winning over both;
> `shared.json` seeded with the Conservative `1.0 USD / 600s / 50 calls` defaults;
> 13 tests in `scripts/lib/__tests__/broker-token.test.mjs` green. Nothing further
> needed.


The operator mentioned the third item was about "tightening the budget json." The only `budget.json` in either repo is `C:/Users/perry/DevProjects/claude-budget-dispatcher/config/budget.json`. The natural tightening candidate is `C:/Users/perry/DevProjects/claude-budget-dispatcher/scripts/lib/broker-token.mjs`, which hardcodes three per-process broker defaults:

```js
const DEFAULT_TTL_SECONDS = 1800;   // 30 min per dispatch run
const DEFAULT_MAX_CALLS   = 200;
const DEFAULT_CAP_USD     = 5.0;
```

These currently can't be tuned per-machine without a code edit. The clean move is a new top-level block in `budget.json`:

```jsonc
"keybroker": {
  "cap_usd": 5.0,
  "ttl_seconds": 1800,
  "max_calls": 200
}
```

…read in `broker-token.mjs` with the existing hardcodes as fallback. Cross-repo work (dispatcher, not keybroker). Maintenance-class, allowed under the validation freeze.

Open question worth checking with operator: are 200 calls × $5 cap × 30min TTL actually too loose? A single dispatch cycle probably needs <50 calls and <$1, and tightening defaults reduces blast radius if a token leaks. Don't change defaults silently — surface a recommendation.

### 2. Path C — `IssueTokenResult` TS narrowing hygiene (LIKELY A NO-OP, document and skip)

The `c22e21c` commit body deferred this:

> "Catching real TS errors revealed by tsc emission (e.g. server.ts narrowing gaps on IssueTokenResult) is deferred to a separate hygiene commit."

But I verified today:

- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npx tsc --noEmit false --outDir C:/tmp/tscheck` (real emission) — clean.
- The call site at `src/server.ts:337` early-returns on `!result.ok` so the success-branch narrowing is sound.

So this is likely a phantom item — the previous instance was speculating about emission errors that don't exist with current strictness settings. **Suggest: close out by amending the next handoff to note "Path C investigated — no narrowing gap under current tsconfig; deferred indefinitely."** Don't burn budget on it unless something concrete surfaces.

### 3. End-to-end mint → route → log smoke (DEFERRED BY DESIGN)

The `c22e21c` commit explicitly says this was out of scope:

> "End-to-end token-mint + provider-routing not exercised this session because dispatcher's task selector chose a `local` task (no LLM call) and the second run lost a distributed-lock race — neither relates to broker routing. Phase 3.2 c4 already smoked the mint+route path."

The "What I deliberately did not do" section in the previous instance's truncated closing confirms: forcing a non-local task to drive the full path would burn free-tier Gemini quota or require selector mods. **Leave deferred** unless the operator asks for a real fresh smoke after the budget.json work.

## Don't drift into

- **No Pro-tier feature work.** The validation experiment freeze is still in effect (`project_validation_experiment_state.md` in `memory/`). +7d decision criteria haven't fired. Maintenance (deps, build, audit closeout) is fine; new features are not.
- **No new handoff files for trivial follow-ups.** Roll completion notes into the next phase's commit body if the work is small. This file exists only because three items got truncated.

## Quick verification checklist for next session

```powershell
# Confirm Dependabot alerts actually closed after the push rescan
gh api repos/pmartin1915/keybroker/dependabot/alerts --jq '.[] | select(.state=="open") | {number, summary: .security_advisory.summary}'

# Confirm build still emits cleanly (regression check before starting new work)
npm run build
npm run typecheck
npx vitest run   # 630 should pass; first run on Windows can flake — re-run if so
```

## Git state at handoff

- Branch: `main`, up to date with origin after `e631810`.
- HEAD: `e631810 chore(deps): bump web/ vite 5.4.11 → 6.4.2 (closes Dependabot ×2)`.
- Working tree: clean except untracked `.claude/` (settings.local.json — not committed historically).

— Opus 4.7 (1M context), 2026-05-14
