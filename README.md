# keybroker

> Replace shared API keys with short-lived, scoped, attributable tokens — without changing your application code.

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

## What's enforced per token

| Constraint        | How                                                                |
| ----------------- | ------------------------------------------------------------------ |
| Provider          | Token claims `prv: "openai"` — calling `/anthropic/*` returns 403. |
| Scope (method+path) | `--scope 'POST:/v1/chat/completions'`. Repeat for multiple. `*` = unrestricted. |
| Model allowlist   | `--model 'gpt-4o-mini'`. Glob patterns (`gpt-4o*`) supported. 403 if the request body asks for a non-allowed model. |
| Quota             | `--max-calls N`. Atomic decrement on every call. 0 → 429.          |
| Spend cap         | `--cap 50` (USD). Pre-flight estimate + post-call reconciliation from the audit log. Denies `cap_exceeded_estimate` or `cap_exceeded`. |
| Expiry            | `--ttl <seconds>`. JWT `exp` + server-side check.                  |
| Revocation        | `keybroker token revoke <id>` — server-side flag, takes effect immediately. `revoke-all --machine <name>` for bulk rotation. |
| Machine           | `--machine` (default `os.hostname()`). Every audit entry carries `mch`. Filter tokens and logs by machine. |
| Tags              | `--team`, `--project`, `--env` for FinOps attribution. Validated against `policy.json` `tag_allowlist` (per-tag, optional). Carried into every audit row for spend roll-ups. |
| Fleet policy      | `~/.keybroker/policy.json`: `forbidden_models` (glob deny-list) + `allowed_providers` + `tag_allowlist` (per-tag allow-list). Hot-reloads without restart. |
| Audit             | Every call (allowed or denied) appended to SQLite `calls` table with token id, label, status, latency, requested model, machine, tags, estimated and actual cost. |
| Spend rollups     | `GET /metrics/spend?bucket=team\|project\|env&since=24h` and `keybroker metrics spend --by team --since 24h` aggregate the audit log by tag for FinOps dashboards. |
| Burn forecast     | `GET /forecast/tokens` and `GET /forecast/tags?bucket=team` (and `keybroker forecast`) least-squares-fit recent daily spend to project days-until-cap per token and burn-rate-ranked tag leaderboards. |

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

## Control plane prototype

A single-file browser prototype ships in `Prototype.html` (React 18, no build step, localStorage persistence). It demonstrates the FinOps + security narrative with:

- Dashboard with cost attribution by team/project and behavioral anomaly cards
- Token management with tag-based filtering, issue/revoke, and bulk rotation
- Audit log with per-call replay (prompt + completion)
- Fleet policy editor with diff preview
- Shadow AI scan with secret-leak detection simulation
- Forecast / burn report showing which tokens and teams hit cap first

Open `Prototype.html` in any modern browser to try it. Data is synthetic and clearly labeled as such.

## Adding a provider

`src/providers/index.ts` is a flat registry:

```ts
mistral: {
  name: "mistral",
  baseUrl: "https://api.mistral.ai",
  authStyle: "bearer",
  stripHeaders: ["host", "content-length", "connection"],
}
```

Then `keybroker secret add mistral` and `keybroker token issue --provider mistral`.

## What this is **not**

This is a **prototype** that demonstrates the developer experience. It is **not** production-ready. Specifically:

- **Master key in plaintext on disk** at `~/.keybroker/config.json`. A real product would use OS keychain (macOS Keychain / Windows DPAPI / `libsecret`) or a KMS. (Phase 1.3)
- **No authentication on the broker itself.** Anyone who can hit the loopback port can call `secret add` via the CLI (because it reads the same config file). Bind only to `127.0.0.1` (the default), or put the broker behind mTLS.
- **No streaming proxy.** Responses are buffered in memory before being returned. Streaming completions, file uploads, and large payloads will not work well. (Phase 1.1 — not yet started)
- **HS256 JWTs.** Symmetric — the same secret signs and verifies. Real deployments should use RS256/EdDSA so verifier-only services can't forge tokens. (Phase 4)
- **No per-second rate limiting.** `--max-calls` is a lifetime counter, not a rate limit. No burst protection. (Phase 4)
- **Single tenant.** No orgs, no users, no RBAC. (Phase 4)

If you ship this to production as-is, you will have a bad time.

**What is already solid:**
- SQLite backend with atomic transactions (Phase 1.2 ✅)
- 236 tests, typecheck clean, GitHub Actions CI on Node 22 / Ubuntu + Windows (Phase 1.4 ✅)
- Per-token model allowlists with glob matching (Phase 2.1 ✅)
- Dollar spend caps with pre-flight estimates and post-call reconciliation (Phase 2.2 ✅)
- Per-machine token attribution and bulk revoke-by-machine (Phase 2.3 ✅)
- Fleet policy with hot reload (Phase 2.4 ✅)
- Machine-identity normalization contract (`normalizeMachine`) (Phase 3.0 ✅)
- Token tag attribution end-to-end (team / project / env) (Phase 3.3 ✅)
- Tag-bucketed spend aggregation (`/metrics/spend`, `keybroker metrics spend`) (Phase 3.4 ✅)
- Linear-regression burn forecast (`/forecast/tokens`, `/forecast/tags`, `keybroker forecast`) (Phase 3.5 ✅)

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for phased plan: production minimums →
Money Rule features (model allowlist, dollar spend caps, per-machine
attribution) → fold into `claude-budget-dispatcher`.

## Why "prototype broker" and not "buy Vault"?

Vault solves the secret-store half. It does not give a developer a one-line, drop-in API-key replacement that a Python SDK or `curl` will accept unmodified. The unsolved problem is the **shape of the developer interface**, not the cryptography. This repo is the smallest possible thing that demonstrates the shape.

## License

MIT — see `LICENSE`.
