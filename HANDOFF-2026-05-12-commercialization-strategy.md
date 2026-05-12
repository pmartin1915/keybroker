# Handoff — Commercialization strategy (2026-05-12)

You are the next instance. This session **did not ship code.** Phase 4.1 c6 shipped at `ff673dc` in the previous session (Phase 4.1 TUI is complete). Working tree is clean; `origin/main` matches local. 630 tests pass.

This handoff captures a strategic conversation about whether keybroker is sellable, what the actual competitive wedge is, and the cheapest test of demand. The output of this session is two documents — `docs/POSITIONING.md` and `memory/commercialization_competitive_landscape.md` — plus this handoff.

**The user's daily budget for this work is "a few hours a day, split between BoardBound and keybroker."** BoardBound is the primary monetization focus. keybroker is side-income / validation-stage.

---

## The strategic finding (read this before doing anything)

**The wedge:** keybroker's differentiator is the intersection of **LLM gateway + TruffleHog-style verified secret detection in one binary.** That intersection is empty on the market today.

What's already shipped by competitors (so do not pitch these as differentiators):
- Secret *detection* in LLM proxies — LiteLLM, LLM Guard (Protect AI), Lakera Guard, Portkey, Cloudflare AI Gateway all ship regex/entropy detection.
- LLM-proxy basics — routing, caching, audit logs, FinOps, virtual keys.

What is genuinely differentiated:
- **Live verification** — calling the real upstream provider (GitHub `/user`, Stripe `/v1/balance`, AWS STS GetCallerIdentity) to confirm a detected secret is *active* before deciding to block. None of the LLM-aware proxies do this. TruffleHog does, but TruffleHog isn't LLM-aware.
- The Layer 1.5 decode-then-scan pass (encoded secrets caught before egress) is also unusual in the LLM-proxy space.

**Bonus market opening:** LiteLLM (the dominant OSS LLM gateway) had three security incidents in the 60 days before this session — March 2026 supply-chain compromise (v1.82.7/.8 stole creds), April 2026 critical pre-auth SQLi (CVE-2026-42208, actively exploited 36 hours after disclosure), and a guardrail-logging incident leaking secret headers. **"Less attack surface, more carefully built"** is a real positioning angle. Also: LiteLLM gates `secret_detection` behind their Enterprise tier; keybroker ships it free.

Full sources and the comparison table live in `memory/commercialization_competitive_landscape.md`.

---

## What `docs/POSITIONING.md` recommends

A **3-hour validation experiment**, not a launch:

| Hour | Task |
|---|---|
| 1 | Audit README claims against code (test count is 630 not 236; "What this is not" disclaimers are stale post-Phase 4.x). |
| 2 | Write one forum post in three variants — r/selfhosted, r/devops, Show HN. 200–300 words each. Lead with one terminal snippet showing a `verified=1` audit row. |
| 3 | Post one venue per day across three days. Reply only to operator-shaped questions. Check responses at +24h and +7d. |

**Decision criteria after a week:**
- **3+ "how do I deploy this" replies from real-operator accounts** → worth a slice of attention; fix obvious gaps (RS256, Docker compose, signed binaries) and find a lighthouse user.
- **1–2 such replies** → mixed signal; park it; revisit after BoardBound revenue.
- **0 replies / only generic "cool project"** → wedge isn't pulling; stop spending time; the repo stays as portfolio.

This decision is **the user's**, not yours. Do not run the validation experiment yourself.

---

## First things to ask the user when invoked

Pick the question that matches what they actually open with. Do not lecture.

1. **If they say "I want to work on keybroker today":** ask whether the 3-hour validation experiment has been run yet, and what the response was. The answer determines everything else.
2. **If they want to ship the validation experiment now:** offer to do Hour 1 (README/claims audit) as the cheapest first step — it's a code-and-docs task you can do well. The forum posts in Hour 2 are *their* voice; offer to draft variants but make clear the user picks tone and posts personally.
3. **If they want to start building Pro-tier features (SSO, RBAC, RS256, multi-tenant) pre-validation:** push back. Quote this handoff. The temptation to pre-build for an audience that may not exist is the failure mode this strategy session was meant to prevent.
4. **If they want to work on BoardBound instead:** do that. BoardBound is primary.

---

## Things to NOT do without explicit instruction

- **Do not start Pro-tier features.** No SSO, no RBAC, no RS256/EdDSA migration, no multi-tenancy, no SOC2 evidence collection. These are post-validation work.
- **Do not write more positioning docs.** `docs/POSITIONING.md` exists and is good enough for v1. Iterate it after validation data, not before.
- **Do not draft cold emails to CISOs, enterprise reach-outs, or sales sequences.** The user's commercial intent is side-income/validation, not enterprise sales.
- **Do not advise pricing.** Pricing comes after demand is proven.
- **Do not start Phase 5.x or any new build phase on keybroker.** The previous handoff (`HANDOFF-2026-05-12-phase-4-1-c6-shipped.md`) explicitly said "no c7 — wait for operator-driven asks." That still holds. Validation comes before more building.

---

## Things that *would* be safe pre-validation work (Hour 1 territory)

Cheap honesty fixes that make the repo defensible if a forum reader clones it:

1. **README test count drift.** README says "236 tests"; reality is 630. Update.
2. **README "What this is not" section is stale.** It lists "no streaming proxy," "no per-second rate limiting," "master key in plaintext on disk" — but Phase 1.3 / 1.1 / 4.0 / 4.1 work has changed several of these. Audit and rewrite honestly.
3. **README "Phase 4.0 (in progress)" line.** Phase 4.0 and 4.1 (TUI) are both complete. Fix.
4. **One screenshot or terminal snippet** showing a `scan_verified=1` audit row — this is the visual asset the forum post will need.
5. **`examples/` README** if missing — operators clone, run `npx tsx src/cli.ts init`, and need a 5-minute "see verified scanning in action" demo. Confirm the echo-upstream walk-through in the README actually works end-to-end on a fresh clone.

These are 1–3 hours each, ship-anytime, and they directly support whichever validation venue the user picks.

---

## Things that would be safe-but-bigger if user picks them

These are post-validation territory, but if the user has time and wants to ship code on keybroker rather than do marketing:

- **Docker compose example.** Single `docker compose up` that runs the broker + the echo upstream + opens the web UI. Will come up in every forum reply.
- **Signed-release pipeline.** GitHub Actions release workflow that produces a signed single-binary build (Node SEA, `node --experimental-sea-config`, or `pkg`). The "minimal attack surface vs. LiteLLM's supply-chain compromise" positioning is undercut if the install path is still `git clone && npx tsx`.
- **Stable ports.** Default port is currently 7843 (TUI/web) / 8787 (older CLI examples). Pick one, update everywhere.

Each of these is a 1–2 session lift. None are urgent. None should be started without the user explicitly asking.

---

## State of the repo

- `main` clean, matches `origin/main`, last commit `ff673dc` (Phase 4.1 c6).
- 630 tests pass. Both typechecks (broker + tui + web) clean.
- No open phase. Phase 4.0 (web UI), 4.1 (TUI), 4.2 (Layer 1.5 + Layer 2 verify) all complete.
- `docs/POSITIONING.md` (new this session) is the v1 strategic doc.
- `memory/commercialization_competitive_landscape.md` (new this session) holds the competitive research with sources.
- `MEMORY.md` index updated to point at the new commercialization memory.

---

## Why this handoff exists

The user explicitly asked, in plain language, whether keybroker is sellable and how. The honest answer required real research (which the previous instance skipped on first pass and was correctly called out for). This handoff captures the result so the next instance doesn't redo the research, doesn't drift into pre-emptive build work, and doesn't invent strategy without the validation data the user hasn't gathered yet.

**The single most important rule for the next instance:** the user's time is split across BoardBound and keybroker. Every hour spent building speculative keybroker features is an hour not spent monetizing BoardBound (the project with higher revenue probability today). Recommend the cheapest validation step. Don't recommend more building.
