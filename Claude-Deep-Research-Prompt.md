# Keybroker — Deep Research Prompt: Inline Secret Scanning (Phase 3.6 + 4.2)

> Paste this into a fresh Claude research / Cowork instance. The goal
> is a research brief that informs Phase 3.6 (regex layer) and Phase
> 4.2 (TruffleHog + Presidio layers) before either ships. Take your
> time. Cite sources. Disagree with the framing if the evidence
> warrants it.

---

## 1. Why this research, why now

Keybroker is a TypeScript credential broker that sits between
applications and LLM providers (OpenAI / Anthropic / Gemini / Mistral,
as of Phase 3.2.5). It already verifies short-lived JWT tokens,
enforces per-token model allow-lists and USD spend caps, and writes
an attributable audit log.

The next "wedge" capability — the thing native providers (OpenAI
project keys, Anthropic workspaces) **cannot do** — is **inline
scanning of outbound prompt bodies** for leaked secrets / PII /
credentials, with a hard 403 block when a match is found. Audit log
records the event as `egress_blocked`.

This is the differentiator the prototype (`Prototype.html`) already
demos as synthetic. The plan (`C:/Users/perry/.claude/plans/i-have-a-
lot-tidy-newt.md` § Phase 3.6 & 4.2) splits this into layers:

| Layer | Scope | Phase |
|---|---|---|
| 1 | Regex detectors (AWS, GitHub PAT, generic high-entropy, SSN, credit card) | 3.6 |
| 2 | TruffleHog verification (regex hit → verify-the-secret-is-live by hitting the upstream API) | 4.2 |
| 3 | Presidio (PII via SLM) | 4.2 |

Phase 3.6 is the next major build after Phase 3.2 closes out. The
plan flags the architectural choices but defers the technical
specifics to research. **This document is that research.**

---

## 2. Hard constraints (don't propose around them)

1. **Inline blocking, not async detection.** A secret in a prompt
   must result in a 403 before bytes leave the broker. Async / batch
   scanners (sentry-style, post-ingest) are out of scope.
2. **Single-machine personal-fleet first.** Keybroker is currently
   used by one developer on three machines via a dispatcher. VPC /
   multi-tenant deploy is Phase 4 territory. Recommendations must
   work on a developer laptop with no separate scanning service.
3. **TypeScript / Node.js 22 on the data path.** External binaries
   are allowed but cost a process spawn per request. Python services
   are allowed only as an optional sidecar (Phase 4.2), never on the
   default path.
4. **Body re-serialization is load-bearing.** Memory note
   `trap_body_reserialization.md`: keybroker's `src/server.ts`
   re-serializes parsed bodies, which breaks multipart and HMAC
   signing. The scanner must operate on the **same byte buffer**
   the broker forwards upstream — otherwise the scan is meaningless
   (the actual bytes upstream sees could differ). Buffer extraction
   already happens at `src/server.ts:262-266`.
5. **Detector-name-only by default in audit logs.** The matched
   substring is the literal secret. Logging it defeats the purpose.
   Operators may enable substring logging for debugging in a
   dedicated path that doesn't touch production audit.
6. **Latency budget: P95 < 10ms added on a 4KB body.** Above that,
   the wedge becomes a regression. Above 50ms it's a non-starter.

---

## 3. The research questions

### A. Regex layer (Phase 3.6) — coverage & quality

A1. **What is the canonical, defensible 2026 baseline pattern set for
inline LLM prompt scanning?** Not "every regex anyone ever wrote" —
the small set with the best false-positive-to-true-positive ratio.
Compare:
- gitleaks (Go, default ruleset)
- detect-secrets (Python, Yelp)
- TruffleHog v3 detectors (the regex part, before verification)
- AWS Macie / GCP DLP infoTypes for the secrets they cover
- Microsoft Security Code Analysis CredScan
- noseyparker (Rust)

For each: what's their public false-positive rate on real prompt
corpora (if any researcher has measured)? Where do they disagree?

A2. **Which secret formats have CHANGED detection signatures since
the AWS key research (2018-era `AKIA[0-9A-Z]{16}`)?** Many providers
rotated to new prefixes (GitHub fine-grained PATs `github_pat_*`,
OpenAI `sk-proj-*`, Anthropic `sk-ant-*`). What is the current
authoritative list of provider-published key formats with prefix +
length + checksum (if any)? Cite the official docs, not blog posts.

A3. **High-entropy / generic detection trade-offs.** A pure
Shannon-entropy detector with no anchor produces 5-15% false
positives on natural language (citations needed). What is the
current best practice for combining entropy with prefix /
character-class heuristics? Is there a defensible "context-aware"
regex (e.g., `password\s*[:=]\s*['"]\S{8,}['"]`) that materially
beats unanchored entropy on prompt bodies specifically?

A4. **Credit card + SSN — keep or drop?** These are PII not secrets.
The plan currently includes them. Argument for keeping: prompts may
contain them; one-shot block prevents accidental leak to model
training. Argument for dropping: false-positive prone, scope creep,
and PII belongs to Presidio (Phase 4.2). What do comparable products
(BoxyHQ, Mosaic, Helicone's middleware) actually do?

### B. Verification layer (Phase 4.2) — TruffleHog economics

B1. **Is TruffleHog's verification model (issue a live API call to
prove the key works) acceptable for inline scanning, or only for
async?** A live verify hits the upstream provider with a synthetic
request — adding latency and cost (and possibly tripping the
provider's anomaly detection). Trade-off: a verified hit is high-
signal (almost zero false positives), but the latency budget breaks.
Document realistic verify latency for the top 5 providers in §A2.

B2. **TruffleHog binary integration in Node.js.** TruffleHog is a
Go binary with a JSON output mode. Three integration shapes:
- Spawn per request (high cost per call, simple)
- Long-lived sidecar over a Unix socket / pipe (lower per-call cost,
  process management overhead)
- Use the TruffleHog detector list directly without the binary
  (re-implement in Node — risky drift, low cost)

Which has shipped in production in any open-source LLM gateway?
What did they choose and why? Note: keybroker is single-tenant,
single-machine — the "is the sidecar worth it" math may differ from
multi-tenant gateways.

### C. PII layer (Phase 4.2) — Presidio vs alternatives

C1. **Is Microsoft Presidio still the right baseline for PII
detection in 2026?** Compare:
- Presidio (Python, spaCy + custom recognizers, 2019-current)
- AWS Comprehend Detect PII (managed, API call per request)
- GCP DLP (managed)
- Whatever new SLM-based PII detector OpenAI / Anthropic shipped
  (Anthropic Claude has a `block_pii` content moderation hook in
  the messages API — investigate)
- Microsoft AI Foundry's prompt guard

What's the latency / cost profile of each on a typical 4KB prompt?
Which can run locally on a laptop?

C2. **PII vs secrets — should they share the scanner path or be
separate?** Argument for shared: one body parse, one block decision.
Argument for separate: PII detectors are stateful (spaCy models load
on first call), secrets detectors are stateless. Different latency
profiles, different policy levers (block vs warn-and-allow).

### D. Architecture (cross-layer)

D1. **Where should the scanner hook into keybroker's request
pipeline?** Current shape: `verify token → policy gate → model gate
→ build body buffer → forward upstream → record audit`. The scanner
needs the body buffer (already built) before forwarding. Options:
- Inside `provSpec.extractRequestMetadata` as a sibling responsibility
  (rejected: extractor is pure, scanner has I/O for layer 2/3)
- A separate `scanRequest` step between extractor and forward
- A `ProviderSpec.scanRequest?: (req: ExtractorInput) => ScanResult`
  per-provider method, so providers can opt out (e.g., echo skips)
- A standalone module called unconditionally for all providers that
  have a body

Which gives the cleanest policy story? "Per-provider opt-out via
spec" vs "global with policy.json deny-list / allow-list of paths"?

D2. **Policy.json schema for scanner config.** Current policy.json
has `forbidden_models`, `allowed_providers`, `tag_allowlist`. Phase
3.6 must add scanner config without breaking the hot-reload contract
(see `src/policy.ts` — 1s TTL cache, fail-OPEN on parse error). 
Propose a schema that supports:
- Enable / disable per detector
- Override action per detector (block / warn / allow)
- Per-provider scanner enable / disable (some providers might not
  want their endpoints scanned, e.g., embedding endpoints that
  receive raw user data the operator knows is sanitized)
- A "skip_paths" glob list (e.g., don't scan `*/models` list calls)

D3. **What does the audit row for an `egress_blocked` event look
like?** Current audit schema (see `src/store-sqlite.ts`) has
`outcome ENUM` plus tag columns from Phase 3.3. Phase 3.6 adds
`egress_blocked`. What other columns should record? `detector`,
`detectorCategory` (secret / pii), `byteOffsetRedacted`,
`policyRule`? Critically: do **not** propose logging the matched
substring by default — that's the secret.

D4. **Streaming.** Phase 1.1 streaming is unshipped. Most modern LLM
calls stream. Inbound prompts are usually non-streaming (the body
arrives whole), but tool-use and multi-turn agentic flows put
incremental content in subsequent requests. Is there any case where
the scanner needs to scan a streamed *outbound* prompt? Cite real
behaviors if so.

### E. Competitive landscape (positioning)

E1. **Who else ships inline LLM scanning in 2026?** Survey:
- LLM gateways: Portkey, Helicone, Braintrust, LangSmith, OpenRouter
- DLP-adjacent: Mosaic, Lakera Guard, NeMo Guardrails
- Cloud-native: AWS Bedrock Guardrails, GCP Model Armor, Azure AI
  Content Safety
- Open-source: vllm with custom guard, LiteLLM proxy plugins

For each: (a) regex / verify / Presidio coverage, (b) inline vs
async, (c) where they're hosted (self-hosted vs SaaS), (d)
licensing. Build a comparison table.

E2. **Where is the actual moat?** "Inline + open-source + works on
your laptop + audited by you" is keybroker's position. Are any of
the products in E1 in that exact quadrant? Or do they all assume
either SaaS (you trust them with prompts) or enterprise self-host
(needs deploy team)? What's the gap?

E3. **Is "egress_blocked as audit outcome" already a recognized
category, or is keybroker introducing the term?** Naming matters
for the demo story.

---

## 4. Deliverable shape

Produce a single Markdown document with the following sections:

1. **Executive summary** — 5 bullets. What should Phase 3.6 ship?
   What should it explicitly NOT ship until 4.2?
2. **Recommended regex detector set for Phase 3.6** — table with
   pattern, source, expected false-positive class, latency cost.
3. **Architecture recommendation** — answers D1–D4 with one
   diagram (Mermaid OK) showing where the scanner hooks into the
   pipeline.
4. **Policy.json schema proposal** — concrete JSON shape.
5. **Phase 4.2 brief** — TruffleHog verification yes/no with
   reasoning; Presidio vs alternatives with one recommendation.
6. **Competitive table** — E1 in a single table.
7. **Open questions** — the things the research didn't resolve.
8. **Citations** — academic / docs / GitHub. Prefer primary sources.

Length budget: 4000–8000 words. Tight beats comprehensive.

---

## 5. Out of scope

- Authentication of the scanner itself (it runs in-process).
- Rate-limiting / DoS protection of the broker (Phase 4).
- Prompt injection detection (different problem, different layer).
- Output / response scanning. **Inbound prompts only.** A future
  phase may add response scanning; not this one.
- Federated learning / training data exclusion.
- Anything specific to fine-tuning APIs (rare in keybroker's traffic).

---

## 6. Repo files worth reading before answering

| File | Why |
|---|---|
| `src/server.ts:240-380` | Request pipeline: token verify → policy → model gate → body buffer. Scanner hooks here. |
| `src/providers/index.ts` | The `ExtractorInput` shape Phase 3.2.5 just established. The scanner's input shape should match or extend this. |
| `src/policy.ts` | Hot-reload contract (1s TTL, fail-OPEN). Don't break it. |
| `src/store-sqlite.ts` | Audit schema. Migration #2 lands here. |
| `Prototype.html` (search for "egress_blocked") | The UX story the backend must support. |
| `HANDOFF-2026-05-10-phase-3-2-5.md` | The "carry-forward stop-and-check-in" list — Phase 3.6 row matters. |
| `Gemini-Deep-Research-Prompt.md` | The prior research handoff (prototype-focused). Tone reference. |
| `C:/Users/perry/.claude/plans/i-have-a-lot-tidy-newt.md` § 3.6 / 4.2 | The plan rows this research answers. |

---

## 7. Anti-goals (don't waste cycles on)

- Don't propose enterprise features (RBAC, audit-log signing,
  HSM-backed master keys). Phase 4+.
- Don't propose Web UI / dashboard work — `Prototype.html` is the
  reference; backend research only.
- Don't recommend rewrites in Rust / Go / other languages. TypeScript
  is the contract. External binaries are fine as sidecars.
- Don't propose using GPT-4 / Claude as the scanner. The whole point
  is that you scan **before** sending to a model.
- Don't write code — propose architecture. The next Claude Code
  instance implements.

---

## 8. Calibration

If you find yourself recommending "use a managed SaaS like X for
this" — stop and reconsider. Keybroker exists because operators
don't want to send their prompts to a third party. The recommendation
must work for "I'm a developer with a laptop and three machines"
unless you're explicitly addressing the Phase 4 enterprise tier.

If you find yourself recommending more than three detectors for the
Phase 3.6 regex layer — stop and prune. The plan says "AWS access
key, GitHub PAT, generic high-entropy, SSN, credit card." That's 5.
Argue *for* dropping ones from that list, not adding ones to it,
unless the new one is non-obvious and high-value.

---

*Take your time. Disagree with the framing if the evidence demands
it. The plan is a hypothesis; this research is the falsifier.*
