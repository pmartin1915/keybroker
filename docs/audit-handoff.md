# Audit handoff — validation experiment plan

Hour 1 / Hour 2 / Hour 3 of the validation experiment are now in the
repo:

- Hour 1 (factual cleanup): `README.md`, commit `68020f9`
- Hour 2 (three post drafts): `docs/hour-2-posts.md`, commit `ee62123`
- Hour 3 (posting + decision playbook): `docs/hour-3-playbook.md`,
  this commit
- Source-of-truth strategy doc: `docs/POSITIONING.md` (in repo)

Before posting any of the three drafts, two audits worth running:

---

## Audit A — Claude Cowork (file-grounded, internal consistency)

Cowork can search the repo. Point it at this prompt:

> Audit the validation experiment plan for keybroker. The plan is in
> `docs/POSITIONING.md`; the three post drafts are in
> `docs/hour-2-posts.md`; the Hour 3 playbook is in
> `docs/hour-3-playbook.md`. The README at HEAD is the un-staled
> version (commit `68020f9`).
>
> Check five things, in order:
>
> 1. **Factual accuracy of the post drafts vs. the actual code.**
>    Are the test counts right? Is "Layer 1.5 (decode-then-scan)"
>    accurately described — does the scanner actually do base64/url/hex
>    decoding before re-running Layer 1? Does Layer 2 actually call
>    GitHub `/user`, Stripe `/v1/balance`, AWS STS `GetCallerIdentity`
>    as claimed, or only some of those? Is the "~150 LoC SigV4"
>    claim in the HN draft accurate against `src/verify` or wherever
>    the SigV4 lives?
>
> 2. **Honesty of the disclaimers.** The drafts all claim "pre-1.0,
>    single-tenant, HS256-only, no rate limiter, no SOC2." Is anything
>    in that list wrong, or missing something a careful HN commenter
>    would catch (e.g. is there *any* rate-limiting at all, is the
>    keychain claim accurate on all three OSes, does the management
>    JWT story have a gap the drafts gloss)?
>
> 3. **The HN snippet problem.** `docs/hour-2-posts.md` flags that the
>    Show HN terminal block shows a `scan:/verified=` column the
>    default `logs` CLI doesn't render. Two proposed fixes: (a) drop
>    the snippet and use the Web UI screenshot only, (b) add a
>    `--with-scan` flag to `logs`. Which is the right call? Is there
>    a third option (e.g. there's already a flag I missed)?
>
> 4. **Headline pattern adherence.** POSITIONING.md prescribes
>    "result + mechanism + honest scope" for the headline pattern.
>    Do all three drafts follow it? Word budgets are 200–300; check
>    each.
>
> 5. **Hour 3 playbook gaps.** Anything missing from the operational
>    checklist that would bite the user mid-experiment? Particular
>    concerns: the reply-triage rules, the +24h/+7d tracking template,
>    the decision threshold.
>
> Return a short report: one section per audit point, GO / FIX / FLAG
> verdict per section, with file:line refs for anything that needs
> changing. Don't rewrite the drafts — just flag.

---

## Audit B — Gemini Deep Research (external claims, no files needed)

This one verifies claims about the *outside world* that POSITIONING.md
makes. Self-contained prompt — no repo access needed:

> I'm validating a positioning claim for an OSS project called
> keybroker. It's a self-hosted LLM proxy (like LiteLLM / Portkey /
> Cloudflare AI Gateway) with one differentiator: when its built-in
> regex scanner flags a secret in an outbound LLM prompt (GitHub PAT,
> Stripe live key, AWS access-key pair), it calls the real provider
> (GitHub `/user`, Stripe `/v1/balance`, AWS STS `GetCallerIdentity`)
> to confirm the credential is *active* before blocking. This is
> TruffleHog's verification model, applied at proxy time on prompts
> instead of at scan time on git repos.
>
> The positioning claim is that **the intersection of "self-hosted
> LLM gateway" and "verified (not regex-only) secret detection" is
> empty as of May 2026**. Verify or refute this. Specifically:
>
> 1. Does **LiteLLM** ship secret detection in the free OSS build, or
>    is it Enterprise-only? Is any of it verification-based, or only
>    regex/entropy?
> 2. Does **Portkey** ship secret detection? Verification-based?
> 3. Does **Cloudflare AI Gateway** ship secret detection?
>    Verification-based?
> 4. Does **Lakera Guard** or **LLM Guard** (the OSS one from
>    protectai) ship verification of detected secrets, or only
>    detection?
> 5. Has any new entrant in the LLM-proxy / LLM-firewall space
>    launched verified-secret-detection in the last 60 days (March
>    2026 onward)?
> 6. The plan also cites three LiteLLM security incidents in the last
>    60 days: a March 2026 supply-chain compromise, CVE-2026-42208
>    (pre-auth SQLi exploited within 36 hours of disclosure), and a
>    guardrail logging incident that leaked secret headers. Verify
>    these happened as described — dates, severity, and resolution
>    status.
> 7. Is the "verify-before-block" framing differentiated, or is it
>    something the market doesn't actually want (e.g. operators
>    prefer fail-fast on regex, accept the false positives)?
>
> Return: a competitor-by-competitor table with current state of
> secret-detection feature, plus a verdict on the intersection-is-empty
> claim. If you find a counter-example, name it specifically.

---

## Suggested order

Run Cowork first (cheaper, file-grounded — fast feedback on whether the
drafts are factually clean). Then Gemini Deep Research (slower, broader
— confirms the wedge story is still real before posting). Don't post
any of the three drafts until both audits return clean or flagged
issues are resolved.
