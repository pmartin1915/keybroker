# Handoff — keybroker Phase 3.0 complete (2026-05-09)

You are the next instance. Phase 3.0 (machine-identity contract — the
carry-over from Phase 2.3) shipped today and is pushed to origin.
Phase 2 is done. Phase 3.1+ (dispatcher integration) is your pickup.

## State of `main`

```
a24e0a1  normalize mch claim + --machine filters to lowercase (Phase 3.0)
8f4d44b  add token-scoped USD spend caps (Phase 2.2)
02edcb9  add handoff for Phase 2.3 → 2.2 transition
febcaec  add per-machine token attribution (Phase 2.3)
34430c5  add fleet policy: forbidden_models + allowed_providers (Phase 2.4)
1ae7893  add per-token model allow-list (Phase 2.1)
```

- Working tree clean. Already pushed to `origin/main`.
- **236/236 tests pass** on Node 22 (up 7 from Phase 2.2's 229). Six unit
  cases in `tests/hostname.test.ts` (case folding, trim, empty,
  whitespace-only, FQDN preservation, idempotence) plus one bundled CLI
  integration in `tests/machine-normalization.test.ts`.
- `npm run typecheck` clean.
- README still intentionally stale — every Phase 2 instance + this one
  punted on it. Plan: one sweep before tackling Phase 3.2 so the public
  surface matches what the dispatcher will integrate against.

## What Phase 3.0 delivered

| Piece | Detail |
| --- | --- |
| `src/hostname.ts` (NEW) | `normalizeMachine(raw): string \| undefined` — trim, then lowercase. Empty / whitespace-only → undefined. Deliberately conservative: NO trailing-dot stripping, NO FQDN truncation. The doc comment names this load-bearing for the broker/dispatcher boundary contract: both sides must apply the *same* function or they drift. |
| `src/cli.ts` — five sites | `token issue --machine` (default = `os.hostname()`, also normalizes `--machine arg`); `token list --machine` filter; `token revoke-all --machine` lookup + display; `logs --machine` filter. All five route through `normalizeMachine` at the CLI boundary. |
| Whitespace footgun guard | `revoke-all --machine "   "` would normalize to undefined; without a guard that becomes `listTokens({machine: undefined})` which returns ALL tokens. Added an explicit refusal with `process.exitCode = 1`. The unit test on `normalizeMachine("   ") === undefined` pins the guard's premise. |
| `src/tokens.ts` doc-only | Added a Phase 3.0 contract block to `BrokerClaims.mch`: "this field SHOULD be the normalized form; the CLI normalizes at issue time, programmatic callers are expected to do the same; verify does NOT re-normalize." `issueToken` itself is unchanged — CLI is the single boundary. |
| `ROADMAP.md` §3.0 (NEW) | Pins the contract for Phase 3.2 to mirror verbatim. Calls out the dispatcher's existing inline `hostname().toLowerCase()` (correct half) vs the missing `trim` (silent half). |

### Acceptance criterion verified

> Token issued from `PERRY-PC` matches `--machine perry-pc` filters and
> bulk-revoke on every fleet member.

`tests/machine-normalization.test.ts > issue→list→revoke-all all agree
on the canonical (lowercase) form` runs the full CLI loop:
issue with `--machine PERRY-PC` → CLI confirms `machine: perry-pc` on
stderr (not the user-supplied form) → `token list --machine PERRY-PC`
matches → `revoke-all --machine PERRY-PC --yes` revokes → `token list
--machine perry-pc` shows REVOKED. 60s test timeout because each
`tsx src/cli.ts ...` spawn is ~1.5s on Windows; the bundled flow keeps
that bill to ~6 spawns.

## Things the next instance should know

### 1. The conservative-rule decision

`normalizeMachine` does **only** trim + lowercase. We deliberately
do not strip trailing dots or truncate FQDNs. Reason: both sides of
the broker/dispatcher boundary must apply the *exact same* function or
they will drift, and `host.local` vs `host.local.` mismatches are
debuggable while silent FQDN-stripping mismatches are not. If the
dispatcher decides on a richer rule in Phase 3.2, port it back to
`src/hostname.ts` here first — the broker is the source of truth.

### 2. issueToken does NOT re-normalize

The CLI is the single normalization boundary. Programmatic callers of
`issueToken` (tests, future API surfaces) are expected to pass the
canonical form themselves. Documented inline on `BrokerClaims.mch`.
This keeps the contract visible at one site rather than smearing it
across two layers that could later disagree. If you're tempted to add
"defense-in-depth" normalization inside `issueToken`, resist — it just
hides bugs in callers that pass non-canonical values.

### 3. Pre-3.0 tokens with mixed-case `mch` won't retroactively normalize

A token issued before this commit with, e.g., `mch: "PERRY-PC"` will
display as `machine=PERRY-PC` in `token list` and will NOT match
`--machine perry-pc`. There are no production tokens at this point so
this isn't a concern. If you ever ship to real users, the migration
story is "old tokens self-heal as they expire." Don't add a one-shot
re-issue — JWTs are signed and immutable; rewriting the audit log is
worse than letting old rows age out.

### 4. The dispatcher's inline `hostname().toLowerCase()` is half right

The dispatcher (`claude-budget-dispatcher/scripts/...`) already
lowercases at every call site (5+ places per the Phase 3 scout). The
*missing* half is `.trim()`, which is functionally a no-op on
real `os.hostname()` output but matters for any user-supplied
`--machine` argument that flows through. When you migrate the
dispatcher in Phase 3.2, port `normalizeMachine` verbatim and replace
every inline `.toLowerCase()` with the helper. Don't add cleverness on
the dispatcher side — symmetry is the whole point.

### 5. CRLF noise on Windows

Same as every Phase 2 commit: `LF will be replaced by CRLF` warnings
for every modified file. Normal — don't try to "fix" it.

### 6. Free-tier audit quota

PAL `codereview` with `model: gemini-2.5-pro` hit the free-tier daily
quota mid-flow today (1× pro call burned the day's allowance). Fell
back to `gemini-2.5-flash`, which ratified the change as merge-ready.
For Phase 3.2 audits, plan around this: do the deep pro review at the
*end* of a phase, not in the middle. Or use the per-minute pro budget
sparingly across 24h.

## What's next — Phase 3.1 / 3.2 (open)

Phase 2 + 3.0 are complete. The remaining Phase 3 work is the broker
fold-in to `claude-budget-dispatcher`. ROADMAP recommends sidecar
(broker as a separate process) over embedded (broker as library); the
dispatcher's existing supervisor logic makes the sidecar story cheap.

### First concrete steps for Phase 3.2

Per the scout I ran today (mapped surface in `claude-budget-dispatcher`):

1. **`scripts/lib/provider.mjs:200`** is where `Bearer ${apiKey}` gets
   injected into outbound requests. That's the single replace site —
   swap to `Bearer ${brokerToken}` where `brokerToken` is minted at
   dispatcher startup against a local `keybroker serve` instance.
2. **`scripts/dispatch.mjs:150–153`** is the dispatcher's `main()`. Add
   a "spawn `keybroker serve` if not reachable on the expected port"
   step ahead of `loadConfig()`. Reap on dispatcher shutdown — the
   PAL MCP orphaned-process bug (2026-05-08) is the warning here:
   parent-death-on-Windows is unreliable; track the broker PID
   explicitly.
3. **Per-machine, per-provider token issuance** at startup. The
   dispatcher knows its hostname (already normalized inline as
   `hostname().toLowerCase()`); replace every inline normalization
   with `normalizeMachine` ported from `src/hostname.ts`.
4. **Health file extension**: `status/health-<machine>.json` already
   exists per scout. Add `keybroker_ok: bool` and last-day spend
   totals (the broker exposes spend via `sumCostUsdByToken`; the
   dispatcher rolls them up).

### Stop and check in with the user when

- You're about to spawn `keybroker serve` from inside the dispatcher.
  That's a real architectural fork (sidecar process management,
  PID tracking, shutdown ordering) — surface the design before
  writing it.
- You hit the README cleanup punt list. README is the public surface
  the dispatcher integration documents itself against; doing it
  cosmetically vs comprehensively is a 30-minute vs 3-hour fork.
- The dispatcher's PowerShell wrapper (`run-dispatcher.ps1` per the
  scout) needs broker-lifecycle changes. PowerShell + Node lifecycle
  is one of the project's recurring sharp edges — quote the wrapper
  before changing it.

Don't check in for routine progress.

## Things NOT to do in Phase 3.2

- Don't ship the dispatcher migration in one PR. Sidecar startup,
  token-issuance-at-startup, and `provider.mjs` Bearer-replacement
  are three independent landmines; small commits each pass through
  CI before stacking.
- Don't add a "broker discovery" service. `KEYBROKER_URL` env var or
  hard-coded `127.0.0.1:<port>` is enough for personal-fleet posture.
- Don't fold the broker's audit log into the dispatcher's status
  files. Phase 3.3 is "dispatcher status files become rollups derived
  from broker JSONL"; the broker log stays the source of truth.
- Don't change `normalizeMachine`. Trim + lowercase is the contract;
  if you find a real drift case, fix it in BOTH repos in one synchronized
  change, not unilaterally on one side.

## Carry-over deferrals (still NOT to fix in Phase 3.2 unless adopted)

| Item | Origin | Why deferred |
| --- | --- | --- |
| README cleanup | Phase 1.x | Plan: one sweep at the *top* of Phase 3.2 (now) so the dispatcher integrates against accurate docs. Bumped from "top of Phase 3" because Phase 3.0 was small enough that the README skip was harmless. |
| TOCTOU race on cap check | Phase 2.2 | Acceptable for personal-fleet posture; close with a serializable transaction wrapping check + initial appendCall when needed. |
| Mid-stream kill on cap overrun | Phase 2.2 | Current contract is end-of-stream reconciliation only. Cosmetic until you have a real $50 streaming runaway. |
| Sub-millisecond glob match cache eviction | Phase 2.4 | Unbounded cache map in `src/glob-match.ts`. In practice tiny. Don't add LRU until there's a reason. |
| Content-Type-aware extraction | Phase 2.1 | Widens the trust boundary onto a client header. Personal-fleet preference is "issue separate tokens for separate concerns." |

## Useful commands

```sh
# from C:/Users/perry/DevProjects/keybroker
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run (all 236)
npm run test:watch                      # iterate
git log --oneline origin/main..HEAD     # confirm nothing unpushed

# Phase 3.0 smoke
npx tsx src/cli.ts token issue --provider echo --machine PERRY-PC
# stderr should print "machine: perry-pc"
npx tsx src/cli.ts token list --machine PERRY-PC
# stdout should show machine=perry-pc (mixed-case filter matches)
```

## Final state

- Phase 3.0 commit `a24e0a1` pushed to `origin/main`.
- 236/236 tests green locally; CI matrix should match.
- Phase 3.2 is your next pickup. Read this file + the in-tree
  `HANDOFF-2026-05-09-phase-2-2.md` before touching the dispatcher.

External audit (gemini-2.5-flash via PAL `codereview`; pro hit
free-tier daily quota mid-flow): 0 critical, 0 high, 0 medium, 1 low
(cosmetic display of pre-3.0 token casing — self-healing). Findings
ratified the implementation as merge-ready.

Take your time.
