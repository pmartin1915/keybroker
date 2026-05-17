# keybroker

> Replace shared API keys with short-lived, scoped, attributable tokens — without changing your application code.

Plus an inline **verified secret scanner** on every outbound prompt: regex-detects API keys (`ghp_`, `sk_live_`, AWS, Slack) leaking out in chat content, then calls the real upstream provider to confirm the credential is actually live before blocking — so a `scan_verified=1` row in your audit log means a real active leak, not a regex false-positive. The intersection of "self-hosted LLM proxy" and "verified secret detection" is empty on the market today; keybroker is the smallest thing that fills it.

One static binary, SQLite-backed, runs on `127.0.0.1` in front of a developer fleet. Pre-1.0, single-tenant — see [What this is **not**](#what-this-is-not) before you ship it anywhere.

## The problem

Your team has an OpenAI API key. It lives in a `.env` file, in CI, on three laptops, and at least one ex-employee's machine. You can't tell who made which call. You can't easily revoke it without breaking everyone. You can't say "this contractor can only call `chat/completions`, max 100 times, for the next hour."

Vault, AWS Secrets Manager, and 1Password Service Accounts each solve **part** of this. None of them are a one-line drop-in for `OPENAI_API_KEY=...`.

## What keybroker does

The broker holds your real upstream key and issues **JWT-shaped tokens** that look like API keys (prefix `brk_`). Your code stays the same — you change two env vars:

```sh
# before
export OPENAI_API_KEY=sk-real-secret-shared-by-everyone

# after
export OPENAI_API_KEY=brk_eyJhbGciOi...   # short-lived, scoped, attributable
export OPENAI_BASE_URL=http://127.0.0.1:8787/openai
```

The broker validates the token, decrements its quota, swaps the header for the real upstream key, forwards the request, logs the call, and returns the response. The application code doesn't know it's there.

## Quickstart

```sh
git clone https://github.com/pmartin1915/keybroker
cd keybroker
npm install

# 1. one-time init (writes config + master key to ~/.keybroker/)
npx tsx src/cli.ts init

# 2. store the upstream key
KEYBROKER_SECRET='sk-your-real-openai-key' npx tsx src/cli.ts secret add openai

# 3. mint a scoped token — only chat completions, max 100 calls, expires in 1 hour
npx tsx src/cli.ts token issue \
  --provider openai \
  --scope 'POST:/v1/chat/completions' \
  --max-calls 100 \
  --ttl 3600 \
  --label 'contractor-acme-may'

# → prints a brk_eyJ... token to stdout, and the audit metadata to stderr

# 4. start the proxy
npx tsx src/cli.ts serve
# keybroker listening on http://127.0.0.1:8787

# 5. point your app at it
export OPENAI_API_KEY=brk_eyJ...
export OPENAI_BASE_URL=http://127.0.0.1:8787/openai
# ... your existing code works unchanged

# 6. see who called what
npx tsx src/cli.ts logs -n 20
npx tsx src/cli.ts token list
npx tsx src/cli.ts token revoke <token-id>
```

## Try it without an upstream key

There's a built-in `echo` provider that points at a tiny local server (`examples/echo-upstream.mjs`). Useful for verifying the proxy without touching a real provider:

```sh
node examples/echo-upstream.mjs &           # listen on :9999
KEYBROKER_SECRET='fake' npx tsx src/cli.ts secret add echo
TOKEN=$(npx tsx src/cli.ts token issue --provider echo --scope '*' --max-calls 5 --ttl 600 --label demo 2>/dev/null)
npx tsx src/cli.ts serve &
curl -X POST http://127.0.0.1:8787/echo/v1/anything \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"hello":"world"}'
```

The echo upstream's response will show you exactly what the broker forwarded, including the swapped `Authorization: Bearer fake` header.

## Deploying as a daemon

The Quickstart runs the broker through `npx tsx` for fast iteration. For a real install on a Linux host, [`examples/systemd/keybroker.service`](./examples/systemd/keybroker.service) is a paste-and-go unit file with a dedicated `keybroker` system user and the usual hardening flags (`PrivateTmp`, `ProtectSystem=strict`, `NoNewPrivileges`). The file header lists the `useradd` / `install` / `systemctl enable` sequence end-to-end. Run `npm run build` first so `dist/cli.js` exists for the unit's `ExecStart` to point at.

The broker binds `127.0.0.1` by design — if you need remote access, put something authenticated in front of it rather than rebinding. [`examples/nginx-front.conf`](./examples/nginx-front.conf) is the smallest thing that works: TLS termination plus your choice of HTTP basic auth (small team behind WireGuard) or mTLS client certs (per-developer, revocable). The brk_ token enforcement still happens inside the broker; the nginx layer is what protects the `/admin/*` management surface and the `/ui` bundle, which don't require a brk_ token to reach.

## What's enforced per token

| Constraint        | How                                                                |
| ----------------- | ------------------------------------------------------------------ |
| Provider          | Token claims `prv: "openai"` — calling `/anthropic/*` returns 403. |
| Scope (method+path) | `--scope 'POST:/v1/chat/completions'`. Repeat for multiple. `*` = unrestricted. |
| Model allowlist   | `--model 'gpt-4o-mini'`. Glob patterns (`gpt-4o*`) supported. 403 if the request body asks for a non-allowed model. |
| Quota             | `--max-calls N`. Atomic decrement on every call. 0 → 429.          |
| Spend cap         | `--cap 50` (USD). Pre-flight estimate + post-call reconciliation from the audit log. Denies `cap_exceeded_estimate` or `cap_exceeded`. |
| Expiry            | `--ttl <seconds>`. JWT `exp` + server-side check.                  |
| Revocation        | `keybroker token revoke <id>` — server-side flag, takes effect immediately. `revoke-all --machine <name>` for bulk revoke; `rotate-all --team/--project/--env/--machine/--provider [--preview\|--dry-run]` revokes + reissues with identical claims; `reissue-batch --from-revoked --since 24h` re-mints already-revoked tokens. |
| Machine           | `--machine` (default `os.hostname()`). Every audit entry carries `mch`. Filter tokens and logs by machine. |
| Tags              | `--team`, `--project`, `--env` for FinOps attribution. Validated against `policy.json` `tag_allowlist` (per-tag, optional). Carried into every audit row for spend roll-ups. |
| Fleet policy      | `~/.keybroker/policy.json`: `forbidden_models` (glob deny-list) + `allowed_providers` + `tag_allowlist` (per-tag allow-list) + `scanner` (egress secret-scan config). Hot-reloads without restart. |
| Egress scanner    | Inline regex scan of every request body before egress. Catches AWS keys, GitHub PATs (`ghp_`/`gho_`), Slack bot tokens, Stripe live keys. On hit: 403 with detector name, audit row `outcome: "egress_blocked"`. Default-on; disable with `"scanner": {"enabled": false}` in `policy.json`. Audit row carries the detector name only — never the matched substring. Phase 4.2a adds Layer 1.5 decode-then-scan (base64, URL-encode, JSON-string-unescape) so encoded secrets are caught before egress. Phase 4.2b adds Layer 2 live verification (see below). |
| Layer 2 verify    | After a regex hit on `github_pat`, `stripe_live_key`, or an AWS `aws_access_key` + secret-key pair, the broker makes a live API call to the upstream (GitHub `GET /user`, Stripe `GET /v1/balance`, AWS STS `GetCallerIdentity` via home-rolled SigV4) to confirm the secret is active. Result is written to the `scan_verified` audit column (`1` = live, `0` = invalid, `NULL` = not checked — e.g. AKIA-only hit with no paired secret-key). Default: fail-**closed** — a timeout or upstream error blocks the request. Operators can opt to `"on_failure": "allow"` in `policy.json` `scanner.verify`. **Operator caveat:** verification is a live API call from the broker's IP using the leaked credential. GitHub's `/user` endpoint records an audit-log entry on the key owner's account; Stripe's `/v1/balance` counts against rate limits; AWS STS calls appear in CloudTrail as a `GetCallerIdentity` from the broker's egress IP. Operators must accept these side effects before enabling verification. Verification is enabled by default in Phase 4.2b/c — set `"scanner": {"verify": {"enabled": false}}` to disable. |
| Audit             | Every call (allowed or denied) appended to SQLite `calls` table with token id, label, status, latency, requested model, machine, tags, estimated and actual cost. |
| Spend rollups     | `GET /metrics/spend?bucket=team\|project\|env&since=24h` and `keybroker metrics spend --by team --since 24h` aggregate the audit log by tag for FinOps dashboards. |
| Burn forecast     | `GET /forecast/tokens` and `GET /forecast/tags?bucket=team` (and `keybroker forecast`) least-squares-fit recent daily spend to project days-until-cap per token and burn-rate-ranked tag leaderboards. |
| Latency telemetry | Per-call `ttft_ms` (prefill) + `tpot_ms_avg` (decode) + `output_tokens` captured at the streaming Transform, persisted to the audit row. `GET /metrics/latency?token=<id>&since=24h` returns p50/p95 over the window. |

## Architecture

```
your app  ──Authorization: Bearer brk_xxx──►  keybroker  ──Authorization: Bearer sk-real──►  OpenAI
                                                  │
                                                  ├─ store: ~/.keybroker/store.sqlite
                                                  │   secrets: AES-256-GCM @ master key
                                                  │   tokens: scopes, quota, spend, expiry, revoked-flag, machine, tags
                                                  │
                                                  └─ audit: SQLite `calls` table (JSONL export available)
```

Tokens are HS256 JWTs (`jose`). The broker verifies the signature, then re-checks the server-side record (allowing revocation and atomic quota / spend decrement that JWT alone can't provide).

## Control plane

The broker ships with two operator surfaces:

**Web UI** — a bundled Vite + React 18 app under `web/`, served at `/ui`. All six screens are live: Dashboard, Tokens, Audit, Forecast, Policy, Shadow AI. Read-only screens are open on loopback; write actions (issue / revoke / rotate / bulk-revoke) require a one-time management JWT (`brkm_…` prefix, separate signing secret, sessionStorage-only, two-step reveal).

```sh
# from the repo root
npm run web:install   # one-time: install web/ deps
npm run web:build     # build web/dist (gitignored)
npm run serve         # broker now serves the UI at http://127.0.0.1:7843/ui/
```

If you hit `/ui/` before building, the broker serves a one-page hint telling you which command to run — no 5xx, no broken page.

For development with hot reload:

```sh
npm run serve         # terminal 1: broker on :7843
npm run web:dev       # terminal 2: Vite dev server proxies /health, /metrics, /forecast to the broker
```

**TUI** — an Ink-based terminal UI under `tui/`, for operators who live in `tmux`. Same six screens; same loopback-only trust posture; same one-time management JWT prompt for write actions. Hotkey vocabulary: lowercase = read (filter / search), uppercase = destructive (Revoke / Rotate). `f` cycles filter pills, `/` enters search, `r` refreshes.

```sh
npm --prefix tui install
npm --prefix tui run dev      # broker must be running on :7843
```

## Adding a provider

`src/providers/index.ts` is a flat registry. Built-in: `openai`, `anthropic`, `gemini`, `mistral`, `echo`. Adding a new bearer-auth provider with an OpenAI-shaped request body is five lines:

```ts
groq: {
  name: "groq",
  baseUrl: "https://api.groq.com/openai",
  authStyle: "bearer",
  stripHeaders: ["host", "content-length", "connection"],
  extractRequestMetadata: jsonRequestMetadata,
}
```

Header-auth providers (e.g. Google's `x-goog-api-key`) set `authStyle: "header"` plus `authHeader: "<name>"`. Providers that put the model in the URL path (Gemini) write a custom `extractRequestMetadata` — see `geminiRequestMetadata` for the pattern.

Then `keybroker secret add <name>` and `keybroker token issue --provider <name>`.

## What this is **not**

This is a **pre-1.0 single-tenant appliance** that demonstrates the developer experience. It is **not** SaaS-ready. Specifically:

- **No SSO / RBAC / multi-tenancy.** Single operator. No orgs, no users, no role separation beyond the read/write split provided by the management JWT.
- **HS256 JWTs only.** Symmetric — the same secret signs and verifies. Real deployments wanting verifier-only services should wait for RS256/EdDSA.
- **No per-second rate limiting.** `--max-calls` is a lifetime counter, not a rate limit. No burst protection.
- **No SOC2 / audit certification.** The audit log is local SQLite; export is JSONL. There's no compliance attestation.
- **Live secret verification has operator-visible side effects.** Layer 2 verify makes real API calls from the broker's IP using the leaked credential — this creates a record on the upstream provider's side (GitHub audit log, Stripe API logs, AWS CloudTrail). Read the Layer 2 row above before enabling.

If you ship this to a multi-team production environment as-is, you will have a bad time. If you run it as a single-operator appliance on `127.0.0.1` in front of a developer fleet, it does what it says.

**What is already solid:**
- 630 tests, dual typecheck (root + `web/` + `tui/`), GitHub Actions CI on Node 22 / Ubuntu + Windows
- Master key in OS keychain (Wincred / macOS Keychain / `libsecret`) with a file-backed fallback for headless server contexts (Phase 1.3 ✅)
- SQLite backend with atomic transactions (Phase 1.2 ✅)
- Streaming proxy with per-call TTFT + TPOT latency telemetry (Phase 3.7 ✅)
- Per-token model allowlists with glob matching (Phase 2.1 ✅)
- Dollar spend caps with pre-flight estimates and post-call reconciliation (Phase 2.2 ✅)
- Per-machine token attribution and bulk revoke-by-machine (Phase 2.3 ✅)
- Fleet policy with hot reload (Phase 2.4 ✅)
- Machine-identity normalization contract (`normalizeMachine`) (Phase 3.0 ✅)
- Token tag attribution end-to-end (team / project / env) (Phase 3.3 ✅)
- Tag-bucketed spend aggregation (`/metrics/spend`, `keybroker metrics spend`) (Phase 3.4 ✅)
- Linear-regression burn forecast (`/forecast/tokens`, `/forecast/tags`, `keybroker forecast`) (Phase 3.5 ✅)
- Egress secret scanner with decoder layer (base64 / URL-encode / JSON-string-unescape) and Layer 2 live verification for `github_pat`, `stripe_live_key`, and AWS access-key/secret-key pairs via SigV4-signed STS — 120 tests across the scanner / decode / verify / sigv4 modules (Phases 3.6, 4.2a, 4.2b, 4.2c ✅)
- Bundled Vite + React web UI at `/ui` and an Ink TUI under `tui/`, both with one-time management-JWT prompts for write actions (Phases 4.0, 4.1 ✅)
- SQLite `admin_audit` table recording issue / revoke / rotate / bulk-revoke events with summary `params_json` (no secret-bearing bytes) (Phase 4.0 c4e ✅)

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for phased plan: production minimums →
Money Rule features (model allowlist, dollar spend caps, per-machine
attribution) → fold into `claude-budget-dispatcher`.

## Why "prototype broker" and not "buy Vault"?

Vault solves the secret-store half. It does not give a developer a one-line, drop-in API-key replacement that a Python SDK or `curl` will accept unmodified. The unsolved problem is the **shape of the developer interface**, not the cryptography. This repo is the smallest possible thing that demonstrates the shape.

## License

MIT — see `LICENSE`.
