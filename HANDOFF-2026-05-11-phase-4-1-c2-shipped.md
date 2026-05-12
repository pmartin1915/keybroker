# Handoff — Phase 4.1 c2 shipped (2026-05-11)

You are the next instance. This session lit the Tokens screen (read-only,
filterable) and locked the filter focus model that c3 / c6 list screens
will reuse. Working tree clean post-commit.

**State at handoff:**
- 607 tests pass (no new tests this commit — c2 is render-only; the
  HTTP contract is unchanged from c1's `tests/tui-client.test.ts`).
- Both typechecks clean (`npm run typecheck`, `npm --prefix tui run typecheck`).
- Main broker bundle unchanged (TUI is a peer package; broker tsconfig
  does not follow `tui/`).
- New files: `tui/src/focus.tsx`, `tui/src/components/TokensScreen.tsx`.
- Modified: `tui/src/App.tsx`, `tui/src/components/HelpOverlay.tsx`.
- No new tui deps. `ink + ink-text-input + react` budget held.

---

## Phase 4.1 status

| Step | Status |
|---|---|
| c1 — scaffold + Dashboard | shipped (`0aa6b66`) |
| c2 — Tokens (read-only filterable list) | **shipped this session** |
| c3 — Audit (filterable list + outcome counts) | not started |
| c4 — Mgmt JWT prompt + Issue + Revoke (single) | not started |
| c5 — Rotate (4-step ceremony) + bulk revoke | not started |
| c6 — Admin audit + Forecast + Policy + Shadow AI | not started |

---

## What c2 ships, in one paragraph

`tui/src/components/TokensScreen.tsx` lights the Tokens nav slot with
a read-only filterable list, mirroring `web/src/components/TokensScreen.tsx`'s
data layer (calls `BrokerClient.fetchTokens()`, same DTOs, same column
set). Filtering uses a **hybrid** focus model: `f` cycles the status enum
(`active` → `revoked` → `all`), `/` opens an inline `ink-text-input` for
the free-text query. A persistent filter status line above the table
shows `filter: active · search: "q"` to mitigate the hidden state of
single-key filters. `↑/↓` move a row cursor, `Enter` opens a detail
panel (overlay), `Esc` closes it. Manual `r` refresh only — invariant 6
holds (no auto-refresh on this screen). The detail panel surfaces the
`noModelsClaim` warning verbatim from the web UI's wording.

The c4+ modal-stack infrastructure starts here: `tui/src/focus.tsx`
adds a `FocusProvider` + `useFocusCapture()` context. Children flip
`capture=true` while owning input (the `/`-search TextInput, the detail
overlay); `AppInner` uses `useInput(..., { isActive: !capture })` so
the global hotkeys (`1`..`6`, `q`, `?`) don't double-fire while a
descendant is typing. c4's mgmt JWT modal will plug into the same
context.

---

## Filter focus model — locked

Codified in `memory/decision_phase_4_1_c1.md` under "c2 filter focus
model (locked 2026-05-11)". TL;DR: hybrid wins because the cheapest
filter (bounded enum) is one keystroke and the most flexible filter
(free-text substring) is a known TUI idiom (`/`). Pure single-key
collides with row affordances; pure modal adds friction to the common
"show me only active" case.

**Reuse contract for c3 / c6:** any list screen that needs filtering
must use the same vocabulary — `f` cycles the bounded enum (in
Audit's case the outcome filter: `ok` / `denied` / `error` /
`egress_blocked` / `all`), `/` opens a substring search, `c` clears
the query, persistent status line is the discoverability mitigation.
Don't introduce a new pattern unless a screen genuinely has no
bounded-enum filter axis — in which case ask Opus.

---

## How to smoke it yourself

```sh
# 1. start the broker
npm run serve

# 2. in another pane
npm --prefix tui install   # one-time
npm start tui              # or: npm start tui -- --broker-url http://...
```

Expected on the Tokens screen (press `2`):

- Table loads with the configured tokens, default filter is `active`.
- Press `f` repeatedly — the chip cycles active → revoked → all.
- Press `/` — search input opens, digits go to the input (not screen
  nav). Type `alpha`, hit Enter. Filter status line updates to
  `search: "alpha"`. Press `c` to clear.
- `↑/↓` walks the cursor; `Enter` opens the detail overlay; `Esc`
  closes it. While the overlay or search input is open, pressing
  `1`..`6` does NOT change screen (that's the focus gate doing its
  job).
- Tokens with no `models` claim show the yellow warning in the
  detail overlay using the same wording as the web UI.

---

## Read these first (next instance)

1. `memory/decision_phase_4_1_c1.md` — the **ten invariants** plus
   the c2 filter focus model lock. Every later commit must respect.
2. `HANDOFF-2026-05-11-phase-4-1-c1-shipped.md` — the c1 architecture
   and the "what NOT to do in c2..c6" list.
3. This file — for the focus-context pattern. c4 will lean on it.

---

## c3 plan (next strict action)

**Screen:** Audit (filterable list + outcome counts).

**Endpoint:** `GET /audit?limit=&token=&machine=` (already exists,
used by web/'s `AuditScreen`). Returns a flat array of `AuditRow`s.

**What c3 owes:**
- A list of recent calls (most-recent-first), columns: timestamp,
  token label, provider, status code, outcome, machine, est cost.
- An outcome filter — cycle with `f`: `all` → `ok` → `denied` →
  `error` → `egress_blocked` → `all`.
- `/`-search on the same fields TokensScreen uses (label, id,
  provider, machine, tags).
- Per-outcome summary card at the top — counts in the visible
  window.

**Pattern reuse:** TokensScreen is the template. Lift the filter
chrome (header + filter bar + hotkey hint + search input) into a
shared component only if c3's code starts repeating it verbatim;
otherwise keep them separate (anti-premature-abstraction — three
similar lines is better than the wrong abstraction).

**Sonnet can implement directly.** The decision is already locked.
If a Sonnet sub-agent is delegated, link `memory/decision_phase_4_1_c1.md`
("c2 filter focus model" section) and `tui/src/components/TokensScreen.tsx`
as the reference.

**Open question Opus owns (carry forward to c3):** none. The
filter pattern is the only architectural decision c3 needs and it's
locked.

---

## c4 plan (further forward)

**Screen:** mgmt JWT prompt (modal) + Issue (modal) + Revoke (per-row).

**Architecture decision Opus owes c4:** the modal-stack pattern
(invariant 5). The focus context lands in c2 as a single boolean.
For c4, if multiple modals can stack (e.g., issue → reveal JWT →
auth-needed retry chain), the context needs to upgrade to a small
stack reducer. Spec it before delegating implementation.

**Reference:** the web/'s `TokensScreen.tsx` `PendingAction` /
`onAuthConfirmed` flow has the auth-retry state machine c4 must
mirror. Read it line-by-line before designing the TUI version —
the resume-pending-action logic is load-bearing.

---

## What NOT to do in c3..c6 (carry forward from c1)

- Don't merge the TUI back into the main package's `dependencies`
  (invariant 1).
- Don't import anything from `web/src/` (invariant 2).
- Don't add a router or state library (invariant 10). If c4's
  modal stack starts feeling tangled, upgrade `FocusProvider` to
  a stack reducer — not a router.
- Don't render Ink in vitest unless adding `ink-testing-library`.
  c1 + c2 are covered by the HTTP-contract test. c4 modal flows
  may genuinely warrant render tests; if so, propose the
  dep addition first.

---

## Stop-and-check-in triggers (carry forward)

- All triggers from prior handoffs apply.
- **NEW for c3:** if the outcome-filter cycle list grows past five
  values, reconsider single-key cycle (operator can't predict the
  next state easily). Five is the soft cap.
- **NEW for c3+:** if a Sonnet sub-agent proposes shared filter
  chrome before there are three concrete consumers (Tokens, Audit,
  Shadow AI), push back. Two consumers is duplication; abstract
  on the third call site.

---

## Final state

- Working tree clean post-commit.
- 607 tests, both typechecks clean.
- `tui/node_modules` covered by `.gitignore`.
- Phase 4.1 c2 is the only Phase 4.1 work shipped in this session.

Take your time. Pick c3 next.
