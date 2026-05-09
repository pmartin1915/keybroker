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
| Quota             | `--max-calls N`. Atomic decrement on every call. 0 → 429.          |
| Expiry            | `--ttl <seconds>`. JWT `exp` + server-side check.                  |
| Revocation        | `keybroker token revoke <id>` — server-side flag, takes effect immediately. |
| Audit             | Every call (allowed or denied) appended to `~/.keybroker/calls.log.jsonl` with token id, label, status, latency, byte counts. |

## Architecture

```
your app  ──Authorization: Bearer brk_xxx──►  keybroker  ──Authorization: Bearer sk-real──►  OpenAI
                                                  │
                                                  ├─ store: ~/.keybroker/store.json
                                                  │   secrets: AES-256-GCM @ master key
                                                  │   tokens: scopes, quota, expiry, revoked-flag
                                                  │
                                                  └─ audit: ~/.keybroker/calls.log.jsonl
```

Tokens are HS256 JWTs (`jose`). The broker verifies the signature, then re-checks the server-side record (allowing revocation and atomic quota decrement that JWT alone can't provide).

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

- **JSON-file storage.** Single-process, no concurrent writers, no WAL, no replication. Fine for a single dev box. Swap for Postgres/SQLite/Redis for anything real.
- **Master key in plaintext on disk** at `~/.keybroker/config.json`. A real product would use OS keychain (macOS Keychain / Windows DPAPI / `libsecret`) or a KMS.
- **No authentication on the broker itself.** Anyone who can hit the loopback port can call `secret add` via the CLI (because it reads the same config file). Bind only to `127.0.0.1` (the default), or put the broker behind mTLS.
- **No streaming proxy.** Responses are buffered in memory before being returned. Streaming completions, file uploads, and large payloads will not work well.
- **HS256 JWTs.** Symmetric — the same secret signs and verifies. Real deployments should use RS256/EdDSA so verifier-only services can't forge tokens.
- **No rate limiting beyond `--max-calls`.** No per-second/per-minute limits, no spend caps in dollars, no cost attribution.
- **No web UI.** CLI only.
- **Single tenant.** No orgs, no users, no RBAC.
- **No tests.** Smoke-tested by hand. There is no CI.

If you ship this to production as-is, you will have a bad time.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for phased plan: production minimums →
Money Rule features (model allowlist, dollar spend caps, per-machine
attribution) → fold into `claude-budget-dispatcher`.

## Why "prototype broker" and not "buy Vault"?

Vault solves the secret-store half. It does not give a developer a one-line, drop-in API-key replacement that a Python SDK or `curl` will accept unmodified. The unsolved problem is the **shape of the developer interface**, not the cryptography. This repo is the smallest possible thing that demonstrates the shape.

## License

MIT — see `LICENSE`.
