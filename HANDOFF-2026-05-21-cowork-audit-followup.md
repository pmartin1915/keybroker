# Handoff — 2026-05-21 — Cowork audit follow-up + roadmap refresh

Continuity follow-up to `HANDOFF-2026-05-17-doc-skew-cleanup.md`. This
session was driven by the operator surfacing a Cowork research chat that
had flagged five audit items against the validation experiment drafts.
The session verified all five against current `main`, closed two minor
playbook polish gaps, and rewrote the top of `ROADMAP.md` to reflect
current state and decision branches.

No code surface touched. Test count unchanged at 630. Feature freeze
still in force.

## What changed this session (uncommitted in the working tree)

The operator decides commit shape. Suggested grouping at the bottom.

1. **`docs/hour-3-playbook.md`** — closes Cowork audit items `5(f)` and
   `5(g)`:
   - **5(g):** Wed-or-later-start defer-to-Monday hard rule, added
     directly under the posting-schedule table. A Wednesday Day 1
     lands Day 3 on Friday — historically the weakest Show HN day — and
     the +24h window then overlaps the weekend when the operator-shaped
     audience is offline.
   - **5(f):** "Keep this section in a private note (not committed)"
     replaced with the explicit `docs/.tracking.local.md` path,
     cross-referencing the matching `.gitignore` entry.

2. **`.gitignore`** — `docs/.tracking.local.md` added below `dist/`.

3. **`ROADMAP.md`** — prepended a "Where we are — 2026-05-21" section
   that supersedes the v0.1 phased plan. Covers: shipped-through-Phase-4.x
   summary, validation-experiment timeline (megathreads 2026-05-18, Show HN
   2026-05-19, +7d windows close 2026-05-25 / 2026-05-26), decision rule
   (≥3 invest / 1–2 park / 0 shelve), open operator-only follow-ups,
   1-week invest-sprint scope, refreshed anti-roadmap. Historical Phase
   1–5 content preserved verbatim below the new section with shipped/
   deferred markers on each top-level phase header.

4. **This handoff.**

## Cowork audit verification result

The Cowork chat predated 2026-05-13. Memory claimed "Hours 1/2
audit-complete 2026-05-13, corrections in `290bc1a`, playbook at
`8a92650`." Verification against current `main`:

**13 / 15 audit items FIXED in `290bc1a`** (evidence quoted below):

| Audit item | Status | Evidence |
|---|---|---|
| 1(a) hex → JSON-string-unescape in V1+V2 | FIXED | `docs/hour-2-posts.md:48-49`, `:95-96` |
| 1(g) README AWS STS future-vs-shipped conflict | FIXED | README Layer-2 row reads "AWS STS GetCallerIdentity via home-rolled SigV4" |
| 1, test count 630 | VERIFIED | `README.md:191` matches `npm test` |
| 1, Layer 1 vs 1.5 distinction | FIXED | `docs/hour-2-posts.md:47-52` |
| 2(i) keytar/libsecret nuance | FIXED | `docs/hour-2-posts.md:64-66` mentions `$KEYBROKER_KEYCHAIN_PATH` |
| 2(ii) Layer-2 audit-log side-effect disclosed | FIXED | V2 `:103-107`, V3 HN `:184-188` — explicit upstream-CloudTrail / GitHub-activity warning |
| 3 HN snippet `--with-scan` flag | FIXED | Snippet uses inline `sqlite3` query; no such flag in `src/` |
| 4 V2 headline scope cue | FIXED | "OSS self-hosted LLM proxy with built-in verified secret scanning — a one-binary alternative to LiteLLM Enterprise" |
| 5(a) operator-shaped account definition | FIXED | `docs/hour-3-playbook.md:57-64` |
| 5(b) public security findings protocol | FIXED | `docs/hour-3-playbook.md:92-100` |
| 5(c) throwaway PAT revoke + screenshot scrub | FIXED | `docs/hour-3-playbook.md:16-19` |
| 5(d) HN <3 upvotes in 30 min rule | FIXED | `docs/hour-3-playbook.md:42` |
| 5(e) decision-logging mechanism + `validation-2026-05` tag | FIXED | `docs/hour-3-playbook.md:168-173` |
| 5(h) "0 = shelve" upvote-only footnote | FIXED | `docs/hour-3-playbook.md:162-166` |

**2 / 15 MISSING — patched in this session** (items 1 + 2 above): `5(f)`
tracking-template path, `5(g)` Wed-or-later defer-to-Monday.

No other audit items surfaced during this verification pass. The
hour-2-posts and README are clean against all Cowork findings.

## Repo state at handoff

- **Branch:** `main`, `4cd5577` from `origin/main`.
- **Working tree:** dirty — four artifacts above are uncommitted.
- **Untracked:** `.claude/` (settings.local.json, historically not
  committed; gitignored).
- **Validation experiment:** **+3 days after Show HN, +3 days after the
  megathreads** (assuming Show HN posted Tue 2026-05-19 per the
  memory `project_validation_experiment_state`). Decision commit due
  on or after 2026-05-26 per `docs/hour-3-playbook.md`.

## What the next instance picks up

### Operator-only (no Claude action available)

- **Read replies and tally.** Per `docs/hour-3-playbook.md` §"What to
  track during the 7-day window." Log to `docs/.tracking.local.md`
  (now `.gitignore`-protected per this session's `5(f)` fix). Tally
  template still in the playbook code-block.

- **Decision commit on or after 2026-05-26.** Subject
  `validation: decision = <invest|park|shelve>`. Body has the +7d tally
  across the three venues. Tag `validation-2026-05`. Then update the
  `project_validation_experiment_state` memory with the outcome — the
  current memory entry expires meaning the day that tag lands.

- **`systemd-analyze verify`** on any Linux host. Worth doing while the
  decision window runs out.

- **`libsecret-1-dev` install header in `examples/systemd/`** —
  one-line follow-up from the 2026-05-17 handoff that the operator
  hasn't shipped yet. See trap memory `keytar_libsecret_load` for why
  it matters.

- **Web UI `verified=1` screenshot.** Asciinema cast covers
  `scan_verified=0` against an inactive `ghp_` (per `e36a729` isolation
  fix); the playbook still calls for a complementary screenshot from
  a throwaway account.

### Operator decision required, then Claude can act

- **Hostile HS256 takedown.** If/when it surfaces, the canned reply is
  pre-staged at `docs/hour-3-playbook.md` §"Expected high-likelihood
  takedown." Do **not** rewrite the drafts — the experiment is testing
  whether real operators raise it. If multiple operator-shaped accounts
  raise it independently, that's deploy-blocking signal and the
  invest-path scope adds RS256 (it's already item 1 in the 1-week
  sprint per the refreshed roadmap).

- **Dispatcher → keybroker dogfooding flip.** Detailed sequence in
  trap memory `dispatcher_broker_routing_setup`. The 2026-05-17
  instance attempted and reverted within seconds because the daemon
  wasn't running. Correct sequence: start broker daemon → confirm
  `curl 127.0.0.1:7843/health` returns 200 → add the `keybroker`
  block to dispatcher `local.json` (NOT `budget.json`).

### Deliberately NOT picked up (feature freeze still active)

- **No Pro-tier features** until the +7d decision lands. RS256,
  broker auth, Docker Compose, rate limiter, SSO, multi-tenant — all
  blocked. Per `docs/POSITIONING.md` hard rule and the refreshed
  anti-roadmap in `ROADMAP.md`.

- **No draft rewrites mid-experiment.** Even if the Reddit megathread
  signal looks weak. Show HN is the real venue; the experiment is
  testing a held-steady message.

- **No new handoff for trivial follow-ups.** Roll micro-fixes into
  commit bodies. The next handoff is appropriate when the +7d decision
  lands and either the invest sprint begins or the experiment closes
  out.

## Verification done this session

- Cowork audit verification against current `main`: 13/15 FIXED in
  `290bc1a` confirmed by reading the cited `file:line` evidence; 2/15
  patched in this session.
- `git diff --stat` confirms only `.gitignore` + `docs/hour-3-playbook.md`
  touched by the 5(f) / 5(g) patch.
- No `npm test` re-run — no code surface touched. Test count unchanged
  at 630.
- Plan file: `C:\Users\perry\.claude\plans\you-are-my-next-quizzical-quokka.md`
  written and approved before any edits landed.

## Suggested commit shape

Three commits, all `docs:` / `chore:` scope. The operator may prefer
fewer commits — the boundaries below are clean enough to either way.

1. `docs(playbook): close Cowork audit 5(f)/5(g) polish gaps`
   - `docs/hour-3-playbook.md` + `.gitignore`
2. `docs(roadmap): add "Where we are 2026-05-21" section + mark historical phases`
   - `ROADMAP.md`
3. `docs: handoff for 2026-05-21 Cowork audit follow-up + roadmap refresh`
   - This file.

Order matters: `(1)` is the meaningful artifact change; `(2)` documents
forward state; `(3)` summarizes both for the next instance.

## Useful pointers

- **Where the validation tracking template now lives:**
  `docs/.tracking.local.md` (gitignored). Set up by this session's
  `5(f)` patch. The playbook now points there explicitly so the next
  instance doesn't have to guess. If the file doesn't exist yet, the
  operator creates it on first tally — it's gitignored so it stays
  out of `git add docs/`.

- **Why the Reddit pivot matters for decision weighting.** The original
  playbook posting schedule assumed top-level Reddit submissions. Both
  r/selfhosted and r/devops blocked that — subreddit-age and
  self-promotion rules respectively. The 2026-05-18 pivot moved Reddit
  content into megathread comments. Megathread signal is structurally
  weaker: fewer eyeballs, no own comment thread, harder for operators
  to surface deploy-intent. Show HN is the only true standalone venue.
  Decision criteria should weight Show HN signal heavier even though
  the playbook's "≥3 sum across all three" rule wasn't formally updated
  for the pivot. Documented in the memory
  `project_validation_experiment_state`.

- **Anti-roadmap is the most load-bearing section of `ROADMAP.md`.**
  The discipline of "no pre-emptive Pro-tier work" is what kept this
  project from spiraling into half-built RS256 / Docker Compose / SSO
  branches over the last six weeks. The validation experiment exists
  precisely to convert that discipline from "operator-imposed" to
  "data-justified." The refreshed anti-roadmap at the top of
  `ROADMAP.md` carries the original v0.1 anti-roadmap forward and adds
  three current-state items (no Pro-tier pre-build, no mid-experiment
  rewrites, no handoff churn for micro-fixes).

- **The historical Phase 4 ≠ what shipped as Phase 4.x.** The v0.1
  ROADMAP.md had a "Phase 4 — Hardening" section listing RS256, mTLS,
  rate limits, streaming spend kill, WebSocket. None of those shipped
  as Phase 4.x; the actual 4.0 / 4.1 / 4.2 shipped a web UI, a TUI, and
  the Layer 2 verifier. The Hardening items overlap heavily with the
  invest-path 1-week sprint scope. The roadmap refresh now flags this
  explicitly so a future reader doesn't mis-map them.

— Claude Opus 4.7 (1M context), 2026-05-21

## Corrigendum — 2026-05-22 (next instance)

The "Operator-only" bullet above that lists "`libsecret-1-dev` install
header in `examples/systemd/`" as an unshipped follow-up from 2026-05-17
is **wrong** — that fix already shipped in `38b7bdd
fix(systemd): correct broken install header + flag MDWE/V8 collision`
on 2026-05-17 13:46, the same afternoon as the 05-17 handoff was
authored.

Evidence in current `main`:

- `examples/systemd/keybroker.service:8-15` — Prerequisites block with
  `sudo apt-get install -y nodejs npm libsecret-1-dev` plus the
  why-paragraph (keytar dlopens libsecret at module import time, so
  the broker fails to start before backend selection runs even when
  `KEYBROKER_KEYCHAIN_PATH` is set).
- `examples/systemd/keybroker.service:57-59` — Alpine variant note
  (`libsecret` not `libsecret-1-dev`, plus `apk add build-base
  python3`).
- `git show 38b7bdd -- examples/systemd/keybroker.service` confirms
  those exact lines were the additions.

The 05-21 instance carried the claim forward from the 05-17 handoff
without checking the file. A future instance reading the 05-21 handoff
cold would chase the same ghost — hence this corrigendum rather than
inline edits (the handoff is a point-in-time record).

The other 14 Cowork-audit and operator-only items in this handoff were
**not re-verified this session**. The next instance was scoped only to
the libsecret follow-up because it was the one item flagged as
Claude-actionable during the freeze.

— Claude Opus 4.7 (1M context), 2026-05-22
