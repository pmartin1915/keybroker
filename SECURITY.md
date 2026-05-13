# Security Policy

keybroker is a pre-1.0 single-tenant appliance. Security disclosure
matters because the project's wedge is *being trustworthy about
secrets*, so a vulnerability we shrug at would be self-defeating.

## Supported versions

Only the most recent commit on `main` is supported. There are no
backported security releases — if you're running an older commit,
the fix is to update.

## Reporting a vulnerability

**Do not file public GitHub issues for security findings.** Public
back-and-forth on an unpatched vulnerability is how brand damage
happens.

Preferred channels, in order:

1. **GitHub private security advisory** — go to the repo's
   [Security tab](https://github.com/pmartin1915/keybroker/security/advisories/new)
   and "Report a vulnerability." This is the canonical channel; it
   gives us a private workspace, a CVE assignment path if warranted,
   and a clean coordinated-disclosure record.
2. **Email** — `pmartin1915@gmail.com` with subject prefix
   `[keybroker-security]`. Use this only if you cannot use the
   GitHub advisory flow. PGP not currently supported.

When reporting, include:

- The commit SHA you tested against (or the release tag).
- Reproducer steps — ideally a minimal repro repo or a single
  `curl` invocation. The bar is "I can reproduce this on a fresh
  clone in under 5 minutes."
- Impact: what does an attacker gain (key disclosure, RCE,
  audit-log bypass, scanner bypass, denial of service, etc.).
- Whether you've shared the finding anywhere else.

## What's in scope

- **Scanner bypass** — any input that defeats Layer 1 regex, Layer
  1.5 decoded-view scanning, or Layer 2 active verification when
  the configured policy says to block.
- **Auth bypass** — issuing tokens (`brk_`) or management tokens
  (`brkm_`) without the correct signing secret; forging a token
  whose claims don't match what was issued.
- **Secret disclosure** — any path that reads the master key,
  decrypts stored upstream keys, or leaks them via logs / audit
  records / error messages / metrics endpoints.
- **Audit-log integrity** — any way to delete, edit, or omit a
  proxied call from the SQLite log when it actually happened.
- **Privilege escalation** between `brk_` tokens and `brkm_`
  management tokens (e.g., a `brk_` token executing
  admin-surface routes).
- **Supply-chain concerns** — anything you spot in our published
  npm dependencies, GitHub Actions, or build outputs.

## What's NOT in scope

These are documented design choices, not bugs. Reports about them
are appreciated as feedback but will not be triaged as security
issues:

- **HS256-only signing.** Single-tenant appliance threat model:
  the broker holds both ends of the signing key, so asymmetric
  signing adds no security here. If you're deploying multi-tenant
  or in a network-exposed configuration, this project isn't
  shaped for it — see the [LiteLLM CVE history](https://github.com/BerriAI/litellm/security/advisories)
  for what happens when a single-tenant tool gets used as a
  multi-tenant one.
- **Loopback-only by default.** There is no TLS termination
  inside keybroker. Run it on `127.0.0.1` and front it with
  whatever your environment uses (sidecar, mTLS proxy, SSH
  tunnel). "No transport auth" is intentional, not an oversight.
- **No rate limiter.** Adding rate limiting before validation
  data is in is on the explicit don't-build list (`docs/POSITIONING.md`).
  If you observe a DoS path that is *also* a memory-corruption
  or auth-bypass path, that is in scope; pure resource exhaustion
  is not.
- **Live verification is a live call.** When Layer 2 verifies a
  flagged secret, the broker calls the real provider from its
  egress IP using the leaked credential. That call appears in the
  upstream provider's audit log (GitHub login activity, Stripe
  rate counters, AWS CloudTrail). This is documented behavior
  (`README.md`, all three Hour-2 post drafts) — operators opt in
  by default and can disable per-detector in `policy.json`.
- **Pre-1.0 surface generally.** Missing SOC2, SSO, RBAC,
  multi-region — none of these are in scope. The project is
  marketed as a one-team appliance.

## Disclosure timeline

I treat 90 days as the default coordinated-disclosure window.
For findings with active exploitation in the wild, faster.
For findings that require a non-trivial threat-model rework,
I'll ask for an extension and explain why.

I will not threaten you with legal action for good-faith research
conducted under this policy. If you find this clause has to be
invoked, something has gone badly wrong on my end.

## Credit

Reporters who follow this policy will be credited in the
advisory and the release notes for the fix commit unless they
ask to remain anonymous.

## Things that are not vulnerabilities

- "You ship secret detection but I can think of a regex you don't
  catch." That's a feature request; please open a normal issue.
- "Your scanner is regex-based, not ML-based." That is the design
  choice documented in `docs/POSITIONING.md`.
- "Your single-binary architecture means a compromise of the host
  compromises everything." Yes — this is a self-hosted appliance.
  The remediation is to run it on a host you trust.
