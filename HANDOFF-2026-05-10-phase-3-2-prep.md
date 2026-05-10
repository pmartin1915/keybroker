# Handoff — keybroker Phase 3.2 prep + control plane (2026-05-10)

You are the next instance. This handoff covers the commit just pushed to
`origin/main` (`977af3b`) — a control plane prototype, backend health
instrumentation, README sweep, and dispatcher surface scout.

---

## State of `main`

```
977af3b  prototype control plane, Phase 3.2 prep, README sweep
a24e0a1  normalize mch claim + --machine filters to lowercase (Phase 3.0)
```

- Working tree clean. Pushed to `origin/main`.
- **83/83 store tests pass** on Node 22 (up from 73; 10 new tests for
  `sumCostUsdSince` + `countCallsSince`).
- `npm run typecheck` clean.
- Full suite: 189 pass, 45 skipped, 5 pre-existing Windows-specific failures
  (proxy hook timeouts, concurrent OOM, keychain init crash, policy-proxy file
  read error — none related to this work).

---

## What this commit delivered

### 1. Prototype.html — control plane (new)

A single-file React dashboard demonstrating the FinOps + security wedge.

**Screens (6):**
| Screen | What it shows |
|--------|---------------|
| Dashboard | Stats cards, spend-by-tag rollups (team/project), cost forecast, behavioral anomaly card, recent audit |
| Tokens | Filterable list with tag pills, issue modal (with team/project/env), token detail with spend progress, **Rotate All** fire drill, **Recovery** batch re-issue |
| Audit | Full audit table with tag column, search, per-call detail with prompt+completion replay + syntax highlighting |
| Forecast | Risk-ranked tokens (days until cap), team burn leaderboard with daily rate |
| Policy | Forbidden models + allowed providers inputs, policy diff preview showing blast radius |
| Shadow AI | Scripted scan animation, policy denials, **Critical Finding** card for secret leak |

**Key flows:**
- Issue token with tags → list → detail → revoke
- Rotate All → blast-radius modal → confirm → recovery modal → batch re-issue by team
- Shadow AI scan → finds `egress_blocked` secret leak

**Design system:** Ink/paper surfaces, lime accent (configurable), SF Mono for data.
**Persistence:** localStorage (`STORAGE_KEY = "keybroker-prototype-v1"`).
**Pinned now:** 10 May 2026 15:42 PT.

**Data is synthetic and clearly labeled as such.**

### 2. Backend — Phase 3.2 prep

| Piece | Detail |
|-------|--------|
| `/health` endpoint | Now returns `{ ok, version, tokens: {active, revoked, total}, calls: {last24h, last24hSpendUsd} }`. Consumed by `listTokens()`, `countCallsSince()`, `sumCostUsdSince()`. |
| `StoreLike` interface | Two new methods: `sumCostUsdSince(ts: string): number` and `countCallsSince(ts: string): number`. |
| `SqliteStore` | Two new prepared statements (`sumCostSince`, `countCallsSince`) using indexed `ts` column. |
| `JsonStore` | Parses JSONL audit log for windowed queries (same posture as existing `sumCostUsdByToken`). |
| `tests/store.test.ts` | 10 new tests: zero-window, timestamp filtering, denied-call exclusion for spend, outcome-agnostic count. |

### 3. README sweep

- "What's enforced" table now includes model allowlist, spend cap, machine attribution, fleet policy, SQLite audit
- Architecture diagram updated to `store.sqlite`
- New "Control plane prototype" section
- "What this is not" rewritten to strike through shipped items
- Added "What is already solid" checklist

### 4. Dispatcher surface scout

Mapped the three Phase 3.2 integration sites in `claude-budget-dispatcher`:

1. **`scripts/lib/provider.mjs:200`** — `Authorization: Bearer ${apiKey}` is the single replace site.
2. **`scripts/dispatch.mjs:150–153`** — `main()` entry point; ideal insertion for sidecar spawn after `loadConfig()`.
3. **`scripts/lib/heartbeat.mjs` + `health.mjs`** — 8+ `hostname().toLowerCase()` sites needing `normalizeMachine` port.

---

## Files you should know about

| File | Role |
|------|------|
| `Prototype.html` | Single-file React control plane. Open in browser directly. |
| `Gemini-Deep-Research-Prompt.md` | Handoff prompt for external AI instances. Paste into Gemini. |
| `src/server.ts` | `/health` endpoint at line ~39. Fastify proxy with token verify → policy → model → scope → consume. |
| `src/store-sqlite.ts` | SQLite store. New statements at lines ~252. |
| `src/store-json.ts` | JSON store (legacy, read-only post-migration). |
| `src/store-types.ts` | `StoreLike` interface. |
| `src/hostname.ts` | `normalizeMachine` — the boundary contract. Port verbatim to dispatcher. |
| `ROADMAP.md` | Phase 3.2 plan: sidecar startup, Bearer replacement, health file extension. |

---

## What's next — Phase 3.2 (open)

ROADMAP recommends **sidecar** (broker as separate process) over embedded.

### First concrete steps (from Phase 3.0 handoff)

1. **Port `normalizeMachine` to dispatcher** — replace all inline `hostname().toLowerCase()` with the helper. Small, safe refactor.
2. **Extend keybroker `/health`** with `keybroker_ok` bool and per-machine spend totals (the dispatcher will read this and write it into `status/health-<machine>.json`).
3. **Add broker-lifecycle spawn** in `dispatch.mjs` main() — start `keybroker serve` if not reachable on expected port. Track PID explicitly (orphaned-process warning from 2026-05-08).
4. **Replace `Bearer ${apiKey}`** in `provider.mjs` with `Bearer ${brokerToken}` — minted at dispatcher startup against local broker.

### Stop and check in with the user when

- You're about to spawn `keybroker serve` from inside the dispatcher. That's a real architectural fork.
- You hit the README cleanup punt list (already done this session, but confirm before touching).
- The PowerShell wrapper (`run-dispatcher.ps1`) needs broker-lifecycle changes.

---

## Things NOT to do in Phase 3.2

- Don't ship the dispatcher migration in one PR. Small commits each.
- Don't add a "broker discovery" service. `KEYBROKER_URL` env var or hard-coded `127.0.0.1:<port>` is enough.
- Don't fold the broker's audit log into the dispatcher's status files. Phase 3.3 handles that.
- Don't change `normalizeMachine`. Trim + lowercase is the contract.

---

## Useful commands

```sh
# from C:/Users/perry/DevProjects/keybroker
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run (all 236)
npx vitest run tests/store.test.ts      # 83 store tests

# Open prototype
start Prototype.html                    # Windows
open Prototype.html                     # macOS
```

---

## Final state

- Commit `977af3b` pushed to `origin/main`.
- 83/83 store tests green locally.
- Phase 3.2 dispatcher integration is your next pickup. Read this file + the in-tree `HANDOFF-2026-05-09-phase-3-0.md` before touching the dispatcher.

Take your time.
