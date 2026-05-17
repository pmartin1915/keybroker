# Hour 2 — three post variants

Drafts for the 3-hour validation experiment in `POSITIONING.md`. One thesis,
three audiences. Headline pattern: *result + mechanism + honest scope*.

## Before posting checklist

- [ ] Capture one screenshot of the **Web UI Audit screen** showing a row with
      `verified=1` next to a real provider name (GitHub / Stripe / AWS). The
      CLI's `logs` command doesn't render the verified column by default, so
      the UI is the cleanest source. (Alternative: a SQLite `SELECT
      ts, reason, scan_verified FROM calls WHERE scan_verified = 1 LIMIT 5;`
      against `~/.keybroker/store.db`.)
- [ ] Stage the snippet for the HN post: a 4–6 line terminal block. Real, not
      faked. Use a throwaway PAT against a test account.
- [ ] Post one venue per day across three days. Cross-posting in the same
      hour is a spam signal.
- [ ] After each: do NOT refresh. Check responses at +24h and +7d. Reply only
      to operator-shaped questions ("how do I deploy this," "does it work
      with vLLM," "what's the perf overhead"). Skip generic feedback.

---

## Variant 1 — r/selfhosted

**Title:** Self-hosted LLM proxy that catches AWS / GitHub / Stripe keys in outbound prompts — and confirms they're live before blocking

**Body:**

I run a small homelab and a couple of side projects that hit OpenAI and
Anthropic. The thing that's been bugging me is that nothing in the self-hosted
LLM-proxy space actually checks whether a leaked secret in a prompt is real,
versus a string that *looks* like one. LiteLLM has regex secret detection but
it's gated behind their Enterprise tier, and even there it's regex-only — it
doesn't call the provider to confirm.

So I built keybroker. It's a single Node binary you point your `OPENAI_API_KEY`
at instead of OpenAI directly. It mints scoped, short-lived tokens (`brk_…`)
that look like API keys, holds the real upstream key locally, and logs every
call with attribution (machine, token label, duration, cost).

The piece I'm trying to validate is the **two-layer scanner**: Layer 1 is
regex against the raw request body; Layer 1.5 re-runs that regex against
decoded views (base64, URL-encoding, JSON-string-unescape) so an encoded
secret in a prompt doesn't slip through; Layer 2 calls GitHub `/user`,
Stripe `/v1/balance`, or AWS STS `GetCallerIdentity` to confirm the secret
is **active**, then writes `verified=1` to the audit row before blocking.
False positives stay `verified=null` and don't pollute the alert stream.

[screenshot: Web UI Audit screen — verified=1 row on a GitHub PAT]

Pre-1.0, single-tenant, HS256 only, no rate limiter, no SOC2. Built as an
appliance for one team / one homelab, not a SaaS. Master key lives in your OS
keychain via keytar (Wincred / macOS Keychain / libsecret) by default; set
`$KEYBROKER_KEYCHAIN_PATH` to opt into a 0600 JSON file instead, which is
the right shape for headless Linux servers without a session-bus libsecret.
630 tests, 120 covering the scan+verify layers.

Repo (MIT): https://github.com/pmartin1915/keybroker

Happy to answer deployment questions.

---

## Variant 2 — r/devops

**Title:** OSS self-hosted LLM proxy with built-in verified secret scanning — a one-binary alternative to LiteLLM Enterprise

**Body:**

LiteLLM users — heads up there's an OSS LLM-proxy alternative shipping
verified secret detection in the free build. I've been watching the
LiteLLM security incident pattern (March 2026 supply-chain compromise,
CVE-2026-42208 pre-auth SQLi exploited within 36 hours and added to
the CISA KEV catalog with federal-network remediation mandate by
May 11, the guardrail logging leak) and decided to take a different
approach: smaller surface, self-hosted appliance, one binary,
loopback-only by default.

What's in the free OSS build:

- Drop-in `OPENAI_BASE_URL` proxy. Your code doesn't change.
- Scoped JWT-style tokens (`brk_…`) with path/method scopes, max-calls,
  TTL, and machine attribution.
- **Layer 1.5 scanner** — regex against decoded views of the request
  body (base64, URL-encoding, JSON-string-unescape) so an encoded
  secret in a prompt doesn't bypass detection.
- **Layer 2 live verification** — on a Layer 1 hit, the proxy calls
  GitHub `/user`, Stripe `/v1/balance`, or AWS STS `GetCallerIdentity`
  to confirm the credential is active before blocking. Audit log
  distinguishes `verified=1` from `verified=null` (regex match, not
  confirmed live), so your incident-response stream isn't full of
  false positives. Trade-off: verification is a live call from the
  broker's egress IP using the leaked credential, so it shows up on the
  upstream provider's audit log (GitHub login activity, Stripe rate
  counters, AWS CloudTrail). Operators must accept this — fail-closed
  default with a policy.json opt-out.
- SQLite-backed call log with cost attribution and FinOps forecasting.
- Web UI + TUI + CLI for the admin surface. Management JWTs (`brkm_…`)
  are signed with a separate secret so leaking an issue-token never
  confers admin rights (also HS256 — same caveat as issue tokens).

Honest scope: pre-1.0, single-tenant, HS256-only signing, no rate
limiter, no SOC2 / SSO / RBAC, no transport auth on the broker itself
(loopback-only by convention). Built as a one-team appliance, not a
multi-tenant SaaS. If you need any of those things, this isn't ready.

If you just want regex-only scanning, LiteLLM Enterprise covers it. If
you want verified scanning in OSS, this is the only thing I'm aware of
that ships it.

Repo (MIT): https://github.com/pmartin1915/keybroker

---

## Variant 3 — Show HN

**Title:** Show HN: keybroker — single-binary LLM proxy that verifies leaked secrets against the real provider before blocking

**Body:**

keybroker is an LLM proxy with one specific opinion: when a regex hit
fires on an outbound prompt (an `sk_live_…`, a `ghp_…`, an AWS
`AKIA…`/secret-key pair), the proxy calls the real provider — GitHub
`/user`, Stripe `/v1/balance`, AWS STS `GetCallerIdentity` — to confirm
the secret is live, *then* blocks. The audit row stores
`verified ∈ {1, 0, null}` so leaked-and-active credentials are
distinguishable from regex false positives.

This is TruffleHog's verification idea, applied at proxy time on the
prompt instead of at scan time on a repo. The intersection of "LLM
gateway" and "verified secret detection" is empty on the market as of
May 2026 — TruffleHog verifies but isn't LLM-aware; LiteLLM is
LLM-aware but its secret detection is regex-only and Enterprise-gated.

Why verify-before-block hasn't existed at proxy time before: human-facing
chat demands sub-second streaming, and a live HTTP call to the issuer
blows the latency budget. Agentic workflows flip both sides of that.
They tolerate per-call latency (an agent doing 30 tool calls doesn't
notice an extra 200ms on the one with a credential in it), and they
can't tolerate false-positive blocks — a regex hit that nukes a
multi-step plan is worse than the leak. So the cost of verification
finally makes sense if the request was going to a model that an agent
is driving anyway.

```
$ sqlite3 ~/.keybroker/store.db <<'SQL'
SELECT ts, reason, scan_verified, provider, path
FROM calls
WHERE outcome = 'egress_blocked'
ORDER BY ts DESC LIMIT 5;
SQL
2026-05-12T18:42:11Z|github_pat|1|openai|/v1/chat/completions
2026-05-12T18:41:42Z|aws_access_key||anthropic|/v1/messages
2026-05-12T18:33:07Z|stripe_live_key|1|openai|/v1/chat/completions
```

(`scan_verified = 1` is the GitHub PAT that came back live from
`/user`. The middle row is regex-only — the AKIA had no paired
secret-key in the prompt, so STS wasn't called and `scan_verified` is
NULL. The CLI's `logs` command surfaces the detector name in its
`reason` column today but not the verify column — query the SQLite
file directly if you want both.)

Trade-off worth knowing about: verification is a live call from the
broker's egress IP using the leaked credential. GitHub's `/user`
records on the key owner's audit log; Stripe `/v1/balance` counts
against rate limits; AWS STS shows up in CloudTrail. Fail-closed by
default, policy.json opt-out.

Stack: Node + Fastify, SQLite (WAL), undici streaming with TTFT/TPOT
telemetry, dual typecheck (strict TS). Master key in OS keychain via
keytar; opt into a 0600 file-backed keychain by setting
`KEYBROKER_KEYCHAIN_PATH` (right shape for headless servers). Web UI
+ TUI + CLI. Layer 2 verifier is ~170 LoC of home-rolled SigV4 — no
AWS SDK dep.

Honest limits: pre-1.0, single-tenant, HS256-only signing (same for
the separate management JWT — leaking either secret = full
compromise of that surface), no rate limiter, no transport auth on
the broker itself (loopback-only by default), no SOC2. Designed as an
appliance, not a SaaS. If you want multi-tenant or enterprise auth
this isn't ready.

MIT, single repo, no managed-service play: https://github.com/pmartin1915/keybroker

Feedback welcome. Particularly interested in whether the
verify-before-block pattern is useful to operators or whether I'm
solving a problem nobody has.
