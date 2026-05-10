# Keybroker — Gemini Deep Research Handoff

> Paste this into a fresh Gemini (or equivalent) chat to continue building the Keybroker control plane prototype.

---

## 1. Product Context

**Keybroker** is a prototype credential broker that replaces shared LLM API keys with short-lived, scoped, attributable tokens — without changing application code. The 2-line proxy swap is the adoption hook:

```bash
# before
export OPENAI_API_KEY=sk-...
# after
export OPENAI_API_KEY=$(keybroker token issue --provider openai)
```

**Pain it solves:**
- Shared keys in `.env` files with no attribution
- Can't revoke one person without rotating everything
- No per-prompt audit, spend caps, or PII scanning
- Panic when someone leaves and you don't know which keys they had

**Defensible wedge:** Cross-provider unification + everything providers can't see (per-prompt audit, cost attribution by team/project, behavioral drift, PII scanning). The providers (OpenAI project keys, Anthropic workspaces) will eat the easy 60%. The moat is FinOps + observability + reliability stacked on security.

**Open positioning question:** Dev tool running on each laptop, or self-hosted broker in a VPC? They sell to different buyers. Pick one in your research and justify it.

---

## 2. What's Already Built

### Backend (Node/TypeScript, shipped in `main`)

See the repo at `C:\Users\perry\DevProjects\keybroker` (or clone from origin). Key modules:

| Module | What it does |
|--------|--------------|
| `src/tokens.ts` | JWT issue/verify with claims (`sub`, `provider`, `scope`, `mdl`, `mch`, `spendUsd`, `capUsd`, `maxCalls`) |
| `src/server.ts` | Fastify proxy with token verify → policy gate → model gate → scope → consume |
| `src/policy.ts` | Fleet policy (`forbidden_models`, `allowed_providers`) with 1s TTL cache, fail-OPEN on parse error |
| `src/glob-match.ts` | Shared `*` glob matcher used by policy and `mdl` claim |
| `src/pricing.ts` | Per-model pricing table for pre-flight cap estimates |
| `src/logging.ts` | SQLite audit log with `requestedModel`, `machine`, `cost`, `reason` columns |
| `src/hostname.ts` | `normalizeMachine(raw)` — trim + lowercase. Load-bearing broker/dispatcher boundary contract. |
| `src/cli.ts` | Full CLI: `token issue/list/revoke/revoke-all`, `logs`, `serve`, `--machine` filters |

**Test status:** 236/236 pass. `npm run typecheck` clean. CI on Node 22 / Ubuntu+Windows.

**Phases shipped:**
- Phase 1: Core broker, SQLite store, proxy, CLI
- Phase 2.1: Per-token model allow-lists (`mdl` claim)
- Phase 2.2: Token-scoped USD spend caps + pricing table
- Phase 2.3: Per-machine token attribution (`mch` claim) + `revoke-all --machine`
- Phase 2.4: Fleet policy (`forbidden_models`, `allowed_providers`)
- Phase 3.0: Machine-identity contract (`normalizeMachine`) + CLI normalization boundary

**Next backend phase:** Phase 3.2 — broker/dispatcher integration (sidecar process, token issuance at startup, health file extension). See `HANDOFF-2026-05-09-phase-3-0.md` in repo root.

**Phase 3.2 prep already done in keybroker:**
- `/health` endpoint returns `{ ok, version, tokens: {active, revoked, total}, calls: {last24h, last24hSpendUsd} }`
- New store methods: `sumCostUsdSince(ts)` and `countCallsSince(ts)` on both `SqliteStore` and `JsonStore` (83 store tests green)
- README cleaned up to reflect actual shipped features

### Frontend Prototype (single-file React)

**File:** `Prototype.html` in repo root.

**Stack:** Single-file, zero build step. React 18 + Babel standalone via CDN. No bundler. localStorage persistence. Opens in any modern browser.

**Design system to inherit:**
- **Palette:** Ink (`#0b0c0f`) / Paper (`#12141a`) / Surface (`#1a1d26`) / Elevated (`#222635`). Text: Primary `#e8e9ec`, Secondary `#9aa0b2`, Muted `#5c6270`.
- **Accent:** Lime (`#c8f560`) by default. Configurable to amber, cyan, rose via Tweaks panel.
- **Surfaces:** 1px `var(--border-subtle)` borders, `var(--radius)` 10px rounding, subtle shadows.
- **Typography:** Sans for UI, SF Mono / Cascadia Code for data.
- **Rhythm:** 24px page padding, 12–16px card gaps, 8px inline gaps.

**Screens already built:**
1. **Dashboard** — stats cards (active tokens, MTD spend, calls today, alerts), cost attribution by tag (team/project), cost forecast card, behavioral anomaly card (scenario-driven), recent audit table.
2. **Tokens** — filterable list with tag pills, search, status/env/team/project filters, issue modal with tag inputs, token detail drawer with spend progress + forecast, **Rotate All fire drill modal** with blast radius preview.
3. **Audit** — full audit table with tag column, search, per-call detail modal showing fake prompt + completion (lorem-style), denial reasons.
4. **Policy** — forbidden models + allowed providers inputs, **policy diff preview** showing how many tokens would be blocked before saving.
5. **Shadow AI** — scripted scan animation, recent denials table.

**Flows that are fully clickable:**
- Issue token (with tags) → appears in list → click → detail → revoke → returns to list with revoked badge.
- Rotate All → fire drill modal shows active count, machine count, estimated CI impact → confirm → all active tokens revoked.
- Policy edit → preview → save → hot-reloads (simulated) in audit.

**Tweaks panel (right rail):**
- Persona switch (SRE / Security / FinOps) — reseeds data
- Scenario switch (Healthy / Breach / Overspend)
- Accent color picker
- Density toggle
- Reset demo data

**Data model:**
```typescript
Token { id, label, provider, scope, model, machine, tags: {team,project,env}, createdAt, expiresAt, revoked, revokedAt, capUsd, spendUsd, calls, lastUsed }
AuditEntry { id, tokenId, tokenLabel, timestamp, provider, model, status, cost, durationMs, tags, requestedModel }
Policy { forbiddenModels: string[], allowedProviders: string[] }
```

**Now pinned:** 10 May 2026 15:42 PT. All timestamps relative to this. Synthetic seed data, not fake traction stats.

---

## 3. What We Just Added (your baseline)

### A. Cost Attribution by Tag
- Issue modal has `team`, `project`, `env` dropdowns
- Dashboard has "Spend by Team" and "Spend by Project" cards with progress bars
- Tokens list shows tag pills inline
- Audit table shows tag pills
- Data derived from audit entries; zero-spend tags still appear

### B. Rotate-All Fire Drill
- Red "Rotate all" button in Tokens header
- Modal shows: active token count, machine count, estimated CI failures, developers needing new tokens, recovery time
- Confirm revokes every active token simultaneously
- **Recovery modal** opens after rotation: group revoked tokens by team, select all/none, batch re-issue with one click

### C. PII / Secret Scanner Simulation
- One synthetic audit entry (`status: "egress_blocked"`) simulates an API key detected inside a prompt
- Shadow AI scan surfaces this as a **Critical Finding** card (distinct from policy denials)
- Audit detail explains: "This is something the upstream provider cannot see. Keybroker intercepted the request on the wire."
- Providers cannot do this; it's a major differentiator in demos

### D. Forecast / Burn Report Screen
- Dedicated **Forecast** nav screen showing risk-ranked tokens (days until cap hit)
- **Team burn leaderboard** with spend, cap, daily burn rate, and days-left
- Color-coded risk: red (<7d), amber (<14d), green

### E. Syntax Highlighting in Audit Replay
- `CodeBlock` component with basic JSON syntax highlighting (strings, numbers, booleans, nulls)
- Makes fake prompt/completion feel closer to a real ops tool

---

## 4. Suggested Next Screens / Features

Prioritized by "punches above its weight in a demo":

1. ~~Per-call replay enhancement~~ ✅ Basic syntax highlighting shipped. Next: token count estimate, latency waterfall.
2. ~~PII / secret scanner on the wire~~ ✅ Shipped — synthetic `egress_blocked` event with Critical Finding card in Shadow AI.
3. ~~Cost forecast intelligence~~ ✅ Shipped — dedicated Forecast screen with team burn leaderboard and risk-ranked tokens.
4. ~~Batch re-issue after rotation~~ ✅ Shipped — Recovery modal with team-grouped selection and one-click batch re-issue.
5. **CLI companion / TUI variant** — A second single-file prototype (`TUI.html` or embedded tab) that mimics a terminal interface. Good for A/B testing GUI vs TUI with operators.
6. **Settings / Operator profile** — Minimal: org name, default cap, notification webhook URL. Keep it under 3 fields. No SSO/SCIM.

---

## 5. Technical Scaffolding (do not change)

- **Single file.** Everything in one `.html`. No build step, no `npm run dev`, no Vite.
- **No external CSS framework.** Use inline styles + the CSS variables in `<style>`.
- **localStorage only.** `STORAGE_KEY = "keybroker-prototype-v1"`. No backend calls.
- **Synthetic data.** All numbers are seeded. Label them clearly if showing to outsiders.
- **Pinned clock.** `PINNED_NOW` is fixed. Do not use `Date.now()`.
- **React 18 + Babel standalone.** Keep JSX in one `<script type="text/babel">`.

---

## 6. Five Questions to Ask Me Up Front

1. **Should the prototype stay single-file, or is it time to split into a real React app?** The handoff says single-file, but at some point the UX ceiling matters.
2. **Which persona is the primary demo target?** SRE (fleet health), Security (breach response), or FinOps (cost attribution)? This changes which screen should be the hero.
3. **Do you want the PII scanner simulation now, or should I build the full batch re-issue recovery flow first?** Both are high-impact but touch different surfaces.
4. **Is the dispatcher integration (Phase 3.2 backend) higher priority than more prototype screens?** The prototype sells the product; the backend ships it.
5. **Should I add a "marketing site" frame around the prototype** (header, pricing, docs links) so it feels like a real product landing page, or keep it as a raw control plane?

---

## 7. Things NOT to Build

- **No SSO/SCIM** — premature for a prototype.
- **No real backend API calls** from the prototype. Keep it localStorage.
- **No pricing page** on the marketing layer (if you add one). We don't know pricing yet.
- **No provider-failover routing** — that's a different product. Keep the wedge tight.
- **No real filesystem access** in Shadow AI. Scripted animations only.
- **No WebSocket or real-time** updates. Polling simulation is fine.
- **No user auth / login screen.** Assume single-operator mode.

---

## 8. Definition of Done

For any feature you add:
- [ ] Fully clickable end-to-end flow with no dead ends
- [ ] Matches the existing palette / type / surface rhythm
- [ ] Persists to localStorage (or reseeds cleanly on persona switch)
- [ ] Works at 1280×800 and 1920×1080
- [ ] No console errors in Chrome/Firefox
- [ ] Synthetic data is clearly synthetic (no fake traction stats)
- [ ] One sentence in this handoff updated to reflect the change

---

## 9. How to Start

1. Read `Prototype.html` in the repo root. Open it in a browser to see current state.
2. Read the backend handoffs (`HANDOFF-2026-05-09-phase-3-0.md` and earlier) to understand the real API surface the prototype will eventually integrate against.
3. Pick one feature from Section 4. Build it. Update this handoff.
4. If in doubt, default to **FinOps cost attribution** as the hero narrative — it's the 10× market expansion from "secure key list" to "LLM spend management."

---

*Take your time. The goal is a demo that sells the wedge, not a feature factory.*
