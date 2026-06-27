# keybroker — Phase 2.1 design review

Review of the per-token model allow-list feature, with focus on the `reason`-string vs. structured-column decision and broader improvement ideas.

---

## TL;DR

- **Add the `requestedModel` column now.** The deferral was wrong — mildly, not catastrophically.
- **Generalize the extractor hook** to return a `RequestMetadata` digest (`model`, `stream`, `maxTokens`) so 2.2 doesn't re-parse the body.
- **Flip to deny-by-default** when `mdl` is set and extraction yields no model. Permissive-on-undefined is a real bypass.
- **Keep both extractor-presence checks** (CLI fail-fast + server fail-closed). They aren't symmetric — comment which is enforcement so a future cleanup pass doesn't delete the runtime one.
- A few smaller flags below: `mdl` runtime shape guard, prefix-matching for model names, audit-log self-containment.

---

## 1. Was deferring the structured `model` column the right call?

**No.** The `reason` field is named and typed as a human-readable explanation. You're now using it as a semi-structured carrier (`model_not_allowed:gpt-4-turbo`), which means downstream consumers do `reason.startsWith("model_not_allowed:")` and split on `:`. That's the moment you've reinvented a column with a worse query interface.

Audit logs are the one place where "we'll fix it later" is genuinely costly: they're append-only by design, so the schema choice today shows up in your historical record forever.

### (a) Queryability today

You can't `grep '"model":"gpt-4-turbo"'` or filter by model in any tool you build between now and 2.2 without a string-parsing special case. Small, but it leaks into every dashboard, CLI grep, and ad-hoc analysis.

### (b) Refactor cost when 2.2 lands

Larger than it looks. You'll have to decide whether to keep producing `model_not_allowed:gpt-4-turbo` for backward compat, or change `reason` to plain `"model_not_allowed"` and break any tooling already grepping the old format. Either way, the denial path gets touched twice — once now, once in 2.2. If you'd added the column now, the denial path is finished; 2.2 only adds the success-path and error-path writers.

### (c) Backwards compat of in-between logs

This is the real cost. Logs from now through 2.2 will have `reason: "model_not_allowed:X"` and no `model` field. Forever. Any historical analysis ("which tokens kept attempting which forbidden models?") needs a parser. Tech debt baked into immutable history is the worst kind.

The cost of doing it now is one new optional field on `CallLogEntry` and one extra line in the denial path. The "do it once in 2.2" framing conflates two unrelated concerns: the **structured column** (cheap, useful immediately) and the **pricing-aware usage parsing** (expensive, genuinely belongs in 2.2). Decouple them.

---

## 2. What shape should the column take?

**`requestedModel?: string` now, add `servedModel?: string` in 2.2.**

There's a real distinction. OpenAI's auto-routing and Anthropic's alias resolution mean the model the upstream actually billed for can differ from what was requested. For pricing in 2.2 you want `servedModel` (when the response confirms it); for allow-list audit you want `requestedModel`.

Don't bake "phase" into the field name (`model_at_request`, `model_in_response`) — that's documenting your code's lifecycle in your data model, which always ages badly. Stick with the noun-based pair: what was asked, what was served.

`model?: string` alone is the second-best option and totally defensible if you want to defer the split, but you'll hit the requested-vs-served distinction the moment 2.2's pricing lookup runs against an Anthropic alias and `used_usd` is off.

---

## 3. Broader improvements

### 3a. Hook signature

`extractRequestedModel(body) => string | undefined` is too narrow. 2.2 will want `max_tokens` for the "refuse to start a request that would push over the cap" check, and `stream` matters because parsing usage from a streaming response is a different code path. You'll end up parsing the same JSON body twice if you keep specialized hooks.

Unify now:

```ts
interface RequestMetadata {
  model?: string;
  stream?: boolean;
  maxTokens?: number;
}
extractRequestMetadata(body: Buffer | undefined): RequestMetadata | undefined;
```

2.1 reads `.model`, ignores the rest. 2.2 reads `maxTokens` for pre-flight cap checks and `stream` for response-parsing dispatch. One JSON parse per request, one place per provider to maintain extraction logic.

There's also a hidden ambiguity in the current return type: `undefined` means both "no model in this request shape" and "body looked like JSON but I couldn't parse it." Those are very different security situations. Consider:

```ts
type Extraction =
  | { kind: "ok"; meta: RequestMetadata }
  | { kind: "no-body" }       // GET, empty body
  | { kind: "unparseable" }   // body present, parse failed
  | { kind: "no-model" };     // parsed JSON, no model field
```

Then server policy can be "deny on `unparseable` when `mdl` is set, allow on `no-body`."

### 3b. Permissive-on-undefined is wrong (when `mdl` is set)

Your pitch for this feature is "stolen `brk_` token can't escalate to expensive models." Today, an attacker with a stolen token sends a body that fails `JSON.parse` (trailing comma, BOM, comment, form-encoded, whatever) and your extractor returns `undefined` → request passes → OpenAI may or may not serve it depending on Content-Type and route. The guard is now contingent on OpenAI's strictness, which isn't your security boundary.

**Deny-by-default when `mdl` is set and extraction yields no model.** GET requests don't bear models, and a model-restricted token shouldn't be hitting model-list endpoints anyway. If you genuinely have a route that takes no model and a model-restricted token should still reach it, allowlist that route explicitly — don't make permissive-on-undefined the global default.

UX loss is small (custom curl with malformed bodies hits a clearer error). Security gain is real.

### 3c. Belt-and-suspenders on the missing-extractor check

Both serve different purposes; neither is dead code, but they aren't symmetric:

- **CLI check** is a UX guard — stops you minting a token that will never work.
- **Server check** is the security boundary.

If you removed the CLI check, security is identical, just worse DX. If you removed the server check, security collapses (you'd be trusting the token issuer ran the latest CLI against the latest provider list — precisely the kind of trust keybroker exists to avoid).

Worth an explicit comment in the runtime check: "this is the actual enforcement; the CLI mirror is UX-only — do not remove on the assumption it's redundant."

---

## 4. Other things flagged in passing

- **`claims.mdl` runtime shape guard.** Verify it's an array of strings, not just truthy with `.length > 0`. A malformed JWT with `mdl: "gpt-4o-mini"` (string, not array) makes `claims.mdl.includes(requestedModel)` do substring matching: `"gpt-4o-mini".includes("gpt-4")` → `true`. JWT schema validation probably catches this, but a runtime `Array.isArray(claims.mdl) && claims.mdl.every(s => typeof s === "string")` in this security-relevant path is cheap insurance.

- **Prefix matching for `mdl`.** Flat exact-match strings will age awkwardly. When OpenAI ships `gpt-4o-mini-2026-01-01`, is a token with `mdl: ["gpt-4o-mini"]` allowed to use it? Decide now. Add `gpt-4o-mini*` semantics before 2.2 lands, because pricing in 2.2 will care about model families and you want allow-list and pricing semantics consistent.

- **Body buffering.** Confirm the raw body is held as a Buffer through the proxy step, not consumed during extraction. A test that asserts the upstream proxy receives bytes identical to what arrived is worth having.

- **Body size cap before `JSON.parse`.** If Fastify's default isn't tightened, a 50MB JSON body forces a parse on every request. Set a sane `bodyLimit` per route or globally.

- **Audit log self-containment.** When you deny for `model_not_allowed`, the entry doesn't record what the token *did* allow. Reconstructable from `tokenId` + the token store, but if the audit log is your "investigate this incident from cold storage" artifact, including `allowedModels: claims.mdl` (or a stable hash) makes it self-contained. Minor — defer if you like.

---

## Net recommendation

Add the `requestedModel` column now. Generalize the hook to `extractRequestMetadata`. Flip to deny-by-default when `mdl` is set and the extractor yields nothing. Keep both extractor-presence checks but comment which is enforcement.

The deferral instinct ("do it once, with full context") is usually right for code. For **log schemas**, it's almost always wrong, because the cost shows up in your historical record rather than your codebase.
