# Handoff — Phase 4.1 c1 shipped (2026-05-11)

You are the next instance. This session opened Phase 4.1 (TUI) with a
scaffolding commit. Working tree is clean; commit `<sha-pending>` will be
on `main` once it lands.

**State at handoff:**
- 607 tests pass (+6 from session start: `tests/tui-client.test.ts`).
- Both typechecks clean (`npm run typecheck`, `npm --prefix tui run typecheck`).
- Main broker bundle unchanged at 224 KB (TUI is a peer package).
- `tui/` directory mirrors the `web/` peer-package shape.

---

## Phase 4.1 status

| Step | Status |
|---|---|
| c1 — scaffold + Dashboard | **shipped this session** |
| c2 — Tokens (read-only filterable list) | not started |
| c3 — Audit (filterable list + outcome counts) | not started |
| c4 — Mgmt JWT prompt + Issue + Revoke (single) | not started |
| c5 — Rotate (4-step ceremony) + bulk revoke | not started |
| c6 — Admin audit + Forecast + Policy + Shadow AI | not started |

---

## What c1 ships, in one paragraph

`tui/` is a new peer package (own `package.json` + `tsconfig.json`)
with three dependencies: `ink`, `ink-text-input`, `react`. The
`keybroker tui` subcommand in `src/cli.ts` lazy-loads the TUI entry
via a string-variable dynamic import — keeps the broker tsconfig free
of JSX and the main package's deps free of Ink. The TUI talks to the
broker over loopback HTTP (`http://127.0.0.1:7843` by default, or
`--broker-url` / `$KEYBROKER_URL`) via `tui/src/api/client.ts`, which
redeclares the same DTOs `web/src/api/client.ts` uses (intentionally
not shared — the contract is the broker's HTTP API). On unreachable
broker the entry prints a clear remediation hint and exits 1. The
6-tab nav (Dashboard / Tokens / Audit / Forecast / Policy / Shadow AI)
mirrors web/'s screen vocabulary so number keys 1..6 map the same on
both surfaces; only Dashboard is live in c1, the other five render a
placeholder that names the commit they ship in.

---

## Read these first

1. `memory/decision_phase_4_1_c1.md` — the **ten load-bearing invariants**
   for Phase 4.1. Every c2..c6 commit must respect them. If a Sonnet
   sub-agent is asked to implement a screen, link this file in their
   brief and add an explicit "stop and ask Opus if you'd need to break
   any of these."
2. `HANDOFF-2026-05-11-phase-4-completion-plan.md` — the original
   Phase 4.1 vs 4.2 fork brief. 4.2 is closed; 4.1 is now the only
   open Phase 4 line item.

---

## Architecture in 30 seconds

```
┌─ keybroker (broker process) ──── 127.0.0.1:7843 ────┐
│                                                     │
│   /health  /tokens  /audit  /metrics/*  /admin/*    │
│                          ▲                          │
└──────────────────────────┼──────────────────────────┘
                           │ loopback HTTP (same contract as web/)
                           │
┌──────────────────────────┴──────────────────────────┐
│   keybroker tui  ──→  tui/src/index.tsx             │
│                       Ink + React render            │
│                       BrokerClient (loopback fetch) │
│                       Dashboard (live in c1)        │
│                       Tokens|Audit|Forecast|...     │
│                         (placeholders in c1)        │
└─────────────────────────────────────────────────────┘
```

Same data layer, different shape. The TUI never imports from `src/`
or `web/src/`; the only cross-boundary call site is the dynamic
import in `src/cli.ts`'s `tui` action handler.

---

## How to smoke it yourself

```sh
# 1. install tui deps (one-time)
npm --prefix tui install

# 2. start the broker
npm run serve

# 3. in another pane, open the TUI
npm start tui
# or with an override:
npm start tui -- --broker-url http://127.0.0.1:7843
```

Expected behavior:
- Dashboard appears with 4 stat cards (active tokens, calls 24h,
  spend 24h, broker version), three tag-bucket cards (team / project
  / env), and a spend-by-machine list.
- Auto-refresh every 5s. Press `r` to refresh now.
- Press `1`..`6` to switch screens; `?` for help; `q` (or Ctrl-C) to
  quit. The placeholder screens announce their target commit.

If the broker is not running, `keybroker tui` prints a stderr error
naming the URL it tried, the fetch reason, and the `keybroker serve`
hint, then exits 1.

---

## c2 plan (next strict action)

**Screen:** Tokens (read-only filterable list).

**Endpoint:** `GET /tokens?machine=<m>` (already exists, used by web/).

**Filter focus model — Opus decision needed before implementation:**

Two viable patterns:
- **Single-key filters at the top bar.** Press `m` → enter a machine
  filter inline; press `t` → team; etc. Filter applies on Enter.
  Pros: fast for muscle memory. Cons: hidden state, no visual
  scaffolding for the operator's eye.
- **Filter modal.** Press `/` → modal with all filter inputs. Apply
  on Enter, dismiss on Esc.
  Pros: discoverable, visible state. Cons: more keypresses for the
  common case.

**My lean:** single-key filters with a persistent status line that
shows the active filter set ("filters: machine=hostA / team=alpha").
The status line is the discoverability mitigation. But this is a
judgment call — make it, document it in `decision_phase_4_1_c1.md`'s
roadmap section, then let Sonnet implement.

**Other c2 invariants to lock before Sonnet:**
- Pagination — the `/tokens` endpoint returns all tokens. For now,
  scroll with arrow keys; defer pagination until a real fleet hits
  ~200 tokens.
- Token-row affordances — in c2, **none** (read-only screen). The
  Revoke / Issue / Rotate affordances land in c4 / c5 with the mgmt
  JWT modal.

---

## What NOT to do in c2..c6

- Don't merge the TUI back into the main package's `dependencies`.
  Invariant 1.
- Don't import anything from `web/src/`. Invariant 2.
- Don't add a router or state library. Invariant 10.
- Don't render Ink in vitest unless adding `ink-testing-library`.
  c1 covers the HTTP contract; that's enough until the modal stack
  (c4+) genuinely needs render tests.

---

## Stop-and-check-in triggers (carry forward)

- All triggers from prior handoffs apply.
- **NEW:** if a c2..c6 commit would add another dep to `tui/`, ask
  Opus first. Ink + React + ink-text-input is the budget; anything
  else (eg `ink-spinner`, `ink-table`, `ink-big-text`) needs a
  justification beyond "would be nicer."
- **NEW:** if `tui/src/api/client.ts` and `web/src/api/client.ts`
  drift in any way other than literal renames, treat it as a bug.
  The two clients share the broker's HTTP API as their contract,
  not each other — but field names, types, and method signatures
  must match in both directions.

---

## Final state

- Working tree clean post-commit.
- 607 tests, both typechecks clean, main broker bundle 224 KB.
- `tui/node_modules` covered by `.gitignore`'s `node_modules/`.
- Phase 4.1 c1 is the only Phase 4 work outstanding from this
  session; nothing else open.

Take your time. Pick c2 next.
