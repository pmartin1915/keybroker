# keybroker — positioning v1 (revised after competitive research)

> Working document. Goal: cheapest possible test of "does this wedge have a market?" before investing real marketing time. Author has competing project (BoardBound) and tight budget — this doc is scoped to a ~3-hour validation experiment, not a launch campaign.

---

## What the competitive research actually showed

Confirmed by reading vendor docs (May 2026):

| Capability | LiteLLM | LLM Guard | Lakera | Portkey | Cloudflare AI Gateway | TruffleHog | **keybroker** |
|---|---|---|---|---|---|---|---|
| LLM proxy / gateway | ✅ OSS | ❌ (library) | ❌ (API) | ✅ OSS | ✅ SaaS | ❌ | ✅ OSS |
| Secret detection (regex) | ✅ Enterprise-only | ✅ OSS | ✅ | ✅ | ✅ | ✅ | ✅ OSS |
| **Live verification** (calls upstream to confirm secret is active) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| One static binary, self-hosted | partial | library only | ❌ | ✅ | ❌ | ✅ | ✅ |
| Scoped per-developer tokens replacing shared API keys | ✅ (virtual keys) | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ |

**The wedge:** the intersection of "LLM gateway" and "verified secret detection" is empty on the market today. Nobody combines them. TruffleHog verifies but isn't LLM-aware. LiteLLM is LLM-aware but doesn't verify.

**Bonus opening:** LiteLLM had three security incidents in the last 60 days — a March 2026 supply-chain compromise, a critical pre-auth SQLi (CVE-2026-42208) actively exploited within 36 hours of disclosure, and a guardrail logging incident that leaked secret headers. The dominant OSS LLM gateway has a credibility wound. "Less attack surface, more carefully built" is a real positioning angle, not marketing fluff.

**Bonus price story:** LiteLLM gates `secret_detection` behind their Enterprise tier. keybroker ships it free and OSS. That's a concrete answer to "why not just use LiteLLM."

---

## Refined one-liner

**The self-hosted LLM proxy with TruffleHog-style verified secret detection built in.**

Sub-pitch (one sentence): *Catches API keys and credentials in outbound LLM prompts, then confirms they're live by calling the real provider before blocking — so your audit log distinguishes a leaked-and-active credential from a false-positive that looks like one.*

---

## The validation experiment (~3 hours total)

The point is to find out, cheaply, whether technical operators want this. Not to launch.

### Hour 1 — Verify the pitch is honest
- Run `npm test` and update README claims (test count, shipped features) so a curious reader who clones the repo doesn't catch a drift.
- Update the README "What this is **not**" section to reflect what's actually shipped in Phase 4.x (the disclaimers are stale — master key, web UI, TUI, audit, verify layer all post-date them).
- Confirm the verified-scanning numbers: how many of the 630 tests cover Layer 2 verification. (Operators will ask.)

### Hour 2 — Write one post, three variants
Single thesis, three audiences. Headline pattern: *result + mechanism + honest scope*.

**For r/selfhosted (homelabbers, privacy-conscious SMB):**
> "Self-hosted LLM proxy that catches AWS/GitHub/Stripe keys in outbound prompts — and confirms they're live before blocking"

**For r/devops (small SRE teams, FinOps):**
> "OSS alternative to LiteLLM with built-in verified secret scanning (LiteLLM gates this behind Enterprise)"

**For Hacker News (Show HN):**
> "Show HN: keybroker — a single-binary LLM proxy that verifies leaked secrets against the real provider before blocking"

Each post is 200–300 words. Lead with one screenshot or terminal snippet showing a `verified=1` audit row. Honest disclaimers in-line ("pre-1.0, single-tenant, HS256-only — built as an appliance, not a SaaS"). Repo link. That's it.

### Hour 3 — Post, then walk away
- Post to one venue per day across three days. (Cross-posting in the same hour is a spam signal.)
- After each: do **not** refresh. Check responses once at +24h and once at +7d.
- Resist the urge to reply to every comment. Reply to operator-shaped questions ("how do I deploy this," "does it work with vLLM," "what's the perf overhead"). Skip generic-feedback comments.

---

## Decision criteria after a week

| Outcome | Decision |
|---|---|
| 3+ "how do I deploy this" / "we'd use this" replies from accounts that look like real operators | Worth a slice of attention. Next: 1-week sprint to fix the obvious gaps (RS256, basic auth on broker, one good Docker compose example) and find a lighthouse user. |
| 1-2 such replies | Mixed signal. Park it. Revisit after BoardBound has revenue. The repo stays public as portfolio + slow-burn OSS. |
| 0 replies, or only generic "cool project" comments | Wedge isn't pulling. Stop spending time on it. The build wasn't wasted — it's a serious portfolio piece and demonstrates real systems work — but it's not a product. |

**Hard rule:** no decision to invest more time until the week of data is in. The temptation will be to start building Pro-tier features pre-emptively. Resist.

---

## What this validation experiment is *not* testing

- It is **not** testing whether you can sell to enterprises. You can't, today, alone, without SOC2 / SSO / RBAC. That's not the question.
- It is **not** testing pricing. Pricing comes after demand is proven.
- It is **not** testing whether to acqui-hire to Lakera or Protect AI. That requires lighthouse deployments first.

It is testing one thing: **does the intersection of "self-hosted LLM proxy" and "verified secret detection" pull interest from technical operators when shown to them in their natural venues**.

---

## If the answer is yes — the realistic 12-month shape

Side-income / validation-stage goal, not full-time pursuit:
- **Months 1–3:** OSS-first. Close the obvious credibility gaps (signed releases, RS256, Docker compose, one-page docs site). Find 1 lighthouse deployment (someone running it for real, willing to be quoted).
- **Months 4–6:** Light commercial tier. Pay-once-or-yearly for a "Pro" build with SSO + multi-tenant + RS256. Target: 3 paying teams at $500–$1,500/yr. ~$3k ARR. Validates willingness to pay.
- **Months 7–12:** Decide. If 5+ paying teams: it's worth raising priority above BoardBound. If 1–3 teams plus OSS traction: keep it on simmer as side income. If still 0–1: shelve and credit the repo as portfolio.

Ceiling realistic case at 12 months: $15–30k ARR + a stronger CV. That's a real outcome for ~6 hrs/week of effort.

---

## If the answer is no — and why that's still a win

- The codebase is a serious portfolio artifact (630 tests, dual typecheck, web UI + TUI + CLI, audit log with FinOps + forecasting, two-layer scanner with live verification).
- It's the kind of project that lands a senior security or platform-engineering role on its own merits.
- The Money Rule's anti-feature-creep discipline visible in the handoffs is itself a hiring signal.

A "no" on the product question doesn't waste the work. It just settles the question.

---

## Open question you'll have to answer yourself

I (the assistant) don't know enough about your competing-attention budget across keybroker + BoardBound + day job to decide whether the 3-hour test is the right cost. If even 3 hours is too expensive this month, the right move is to **wait until after BoardBound's next monetization milestone** and run this experiment then. Forum posts don't go stale, and the LiteLLM-security-incident opening will still exist (and probably widen).
