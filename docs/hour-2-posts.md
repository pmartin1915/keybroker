# Hour 2 — three post variants

Drafts for the 3-hour validation experiment in `POSITIONING.md`. One thesis,
three audiences. Headline pattern: *result + mechanism + honest scope*.

## Before posting checklist

- [ ] Capture one screenshot of the **Web UI Audit screen** showing a row with
      `verified=1` next to a real provider name (GitHub / Stripe / AWS). The
      CLI's `logs` command doesn't render the verified column by default, so
      the UI is the cleanest source. (Alternative: a SQLite `SELECT
      ts, scan_blocked, scan_verified, scan_detector FROM calls WHERE
      scan_verified = 1 LIMIT 5;` against `~/.keybroker/keybroker.db`.)
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
regex + base64/url/hex decoding (so `echo $TOKEN | base64` doesn't bypass it);
Layer 1.5 retries against decoded payloads; Layer 2 calls GitHub
`/user`, Stripe `/v1/balance`, or AWS STS `GetCallerIdentity` to confirm the
secret is **active**, then writes `verified=1` to the audit row before
blocking. False positives stay `verified=null` and don't pollute the alert
stream.

[screenshot: Web UI Audit screen — verified=1 row on a GitHub PAT]

Pre-1.0, single-tenant, HS256 only, no rate limiter, no SOC2. Built as an
appliance for one team / one homelab, not a SaaS. Master key lives in your OS
keychain (Wincred / macOS Keychain / libsecret). 630 tests, 120 covering the
scan+verify layers.

Repo (MIT): https://github.com/pmartin1915/keybroker

Happy to answer deployment questions.

---

## Variant 2 — r/devops

**Title:** OSS alternative to LiteLLM with built-in verified secret scanning (LiteLLM gates this behind Enterprise)

**Body:**

LiteLLM users — heads up there's an OSS LLM-proxy alternative shipping
verified secret detection in the free build. I've been watching the
LiteLLM security incident pattern (March 2026 supply-chain compromise,
CVE-2026-42208 pre-auth SQLi exploited within 36 hours, the guardrail
logging leak) and decided to take a different approach: smaller surface,
self-hosted appliance, one binary.

What's in the free OSS build:

- Drop-in `OPENAI_BASE_URL` proxy. Your code doesn't change.
- Scoped JWT-style tokens (`brk_…`) with path/method scopes, max-calls,
  TTL, and machine attribution.
- **Layer 1.5 scanner** — regex + decode (base64 / url / hex) so an
  encoded secret in a prompt doesn't bypass detection.
- **Layer 2 live verification** — on a Layer 1 hit, the proxy calls
  GitHub / Stripe / AWS STS to confirm the credential is active before
  blocking. Audit log distinguishes `verified=1` from `verified=null`
  (regex match, not confirmed live), so your incident-response stream
  isn't full of false positives.
- SQLite-backed call log with cost attribution and FinOps forecasting.
- Web UI + TUI + CLI for the admin surface. Management JWTs (`brkm_…`)
  are signed with a separate secret so leaking an issue-token never
  confers admin rights.

Honest scope: pre-1.0, single-tenant, HS256-only signing, no rate
limiter, no SOC2 / SSO / RBAC. Built as a one-team appliance, not a
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

```
$ npx tsx src/cli.ts logs -n 3 --machine perry-pc
2026-05-12T18:42:11Z  BLOCKED  403  POST    openai/v1/chat/completions  12ms   token=brk_a1b2  machine=perry-pc  scan:github_pat verified=1
2026-05-12T18:41:58Z  OK       200  POST    openai/v1/chat/completions  812ms  token=brk_a1b2  machine=perry-pc
2026-05-12T18:41:42Z  BLOCKED  403  POST    anthropic/v1/messages       9ms    token=brk_a1b2  machine=perry-pc  scan:aws_key   verified=null
```

(The CLI rendering above adds the `scan:` suffix manually — by default
`logs` omits the scan column. The Web UI Audit screen surfaces it
directly.)

Stack: Node + Fastify, SQLite (WAL), undici streaming with TTFT/TPOT
telemetry, dual typecheck (strict TS), 630 tests. Master key in OS
keychain. Web UI + TUI + CLI. Layer 2 verifier is ~150 LoC of
home-rolled SigV4 — no AWS SDK dep.

Honest limits: pre-1.0, single-tenant, HS256-only, no rate limiter, no
SOC2. Designed as an appliance, not a SaaS. If you want multi-tenant or
enterprise auth this isn't ready.

MIT, single repo, no managed-service play: https://github.com/pmartin1915/keybroker

Feedback welcome. Particularly interested in whether the
verify-before-block pattern is useful to operators or whether I'm
solving a problem nobody has.
