import { matchesGlob } from "./glob-match.js";

/**
 * Per-token dollar caps (Phase 2.2).
 *
 * Pre-flight: when a token has a `cap` claim, the broker estimates the cost of
 * the call from `model + maxTokens` and refuses requests that would push the
 * token's cumulative spend above the cap.
 *
 * Post-call: the proxy parses upstream usage (when present) and records both
 * an `estimatedCostUsd` and an `actualCostUsd` on the audit entry. Spend is
 * computed on demand from the calls table — see `StoreLike.sumCostUsdByToken`.
 *
 * Pricing patterns are matched in declaration order; first match wins. Put
 * specific entries first and broader globs last. Personal-fleet preference:
 * USD only, no FX.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputUsdPerMTok: number;
  /** USD per 1M output tokens. */
  outputUsdPerMTok: number;
}

interface PriceRule extends ModelPrice {
  /** glob-matched against the model name; first match wins. */
  pattern: string;
}

/**
 * Pricing as of May 2026. Numbers are best-effort and only matter for the
 * cap check — under-estimating risks letting a request through that nicks
 * the cap; over-estimating denies more aggressively. Both are operator-
 * recoverable (raise the cap or update this table) and neither leaks to
 * the wire, so we err toward the published list price rather than a
 * negotiated discount the broker can't see.
 *
 * If you add a new entry, place it BEFORE any broader glob it should
 * override (e.g. `gpt-4o-mini` must come before `gpt-4o*`).
 */
export const PRICING: PriceRule[] = [
  // OpenAI — most specific first.
  { pattern: "gpt-4o-mini*", inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
  { pattern: "gpt-4o*", inputUsdPerMTok: 2.5, outputUsdPerMTok: 10 },
  { pattern: "gpt-4-turbo*", inputUsdPerMTok: 10, outputUsdPerMTok: 30 },
  { pattern: "o1-mini*", inputUsdPerMTok: 1.1, outputUsdPerMTok: 4.4 },
  { pattern: "o1*", inputUsdPerMTok: 15, outputUsdPerMTok: 60 },

  // Anthropic.
  {
    pattern: "claude-opus-4-7*",
    inputUsdPerMTok: 15,
    outputUsdPerMTok: 75,
  },
  {
    pattern: "claude-sonnet-4*",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
  },
  {
    pattern: "claude-haiku-4*",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
  },
  // Legacy 3.x fallback for any pre-existing tokens.
  {
    pattern: "claude-3-5-*",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
  },
];

/**
 * Look up a model's price. Returns undefined for an unknown model — caller
 * decides what to do (with a cap set, the server denies; without a cap,
 * the request flows normally with no cost estimate).
 */
export function priceForModel(model: string): ModelPrice | undefined {
  for (const rule of PRICING) {
    if (matchesGlob(model, rule.pattern)) {
      return { inputUsdPerMTok: rule.inputUsdPerMTok, outputUsdPerMTok: rule.outputUsdPerMTok };
    }
  }
  return undefined;
}

/**
 * Pre-flight cost estimate, OUTPUT-ONLY by default.
 *
 * The broker has no tokenizer, so it cannot count input tokens from a raw
 * chat-completions body without bringing one in. We therefore default
 * `inputTokens` to 0 — the returned figure is an output-only estimate
 * (max_tokens × output price). Input cost is the estimate's missing
 * portion, not a tightened bound. Operators MUST pad the cap for that:
 * a $5 cap will let through a request whose actual cost is $5 + (your
 * input tokens × input rate). Long-context callers can blow past the cap
 * before the broker notices because the pre-flight check fires only on
 * the (zero-input) output ceiling.
 *
 * The function name was changed from `estimateCostUsd` to make this
 * limitation visible at every call site. If a future Phase adds a real
 * tokenizer, switch the default of `inputTokens` and rename to
 * `estimateCostUsd`.
 *
 * Returns undefined if the model isn't priced.
 */
export function estimateOutputCostUsd(args: {
  model: string;
  maxTokens?: number;
  /** Optional input-token hint; default 0 (conservative). */
  inputTokens?: number;
}): number | undefined {
  const price = priceForModel(args.model);
  if (!price) return undefined;
  const inTok = args.inputTokens ?? 0;
  const outTok = args.maxTokens ?? 0;
  return (
    (inTok / 1_000_000) * price.inputUsdPerMTok +
    (outTok / 1_000_000) * price.outputUsdPerMTok
  );
}

/**
 * Compute the actual USD cost from a parsed usage object.
 */
export function actualCostUsd(args: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number | undefined {
  const price = priceForModel(args.model);
  if (!price) return undefined;
  return (
    (args.inputTokens / 1_000_000) * price.inputUsdPerMTok +
    (args.outputTokens / 1_000_000) * price.outputUsdPerMTok
  );
}

/**
 * Parsed usage from an upstream response. Both OpenAI and Anthropic emit
 * `usage` objects; we normalize to a shared shape.
 */
export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Best-effort usage extractor. Handles three shapes:
 *
 *  1. OpenAI buffered JSON:
 *       { ..., usage: { prompt_tokens, completion_tokens } }
 *  2. Anthropic buffered JSON:
 *       { ..., usage: { input_tokens, output_tokens } }
 *  3. SSE streaming (final event when stream_options.include_usage:true,
 *     or Anthropic's message_delta events with usage):
 *       data: {"usage":{"prompt_tokens":..,"completion_tokens":..}}
 *       data: {"usage":{"input_tokens":..,"output_tokens":..}}
 *
 * The argument is the entire response body (or for streaming, a tail
 * buffer that's expected to contain the last few SSE events). Returns
 * undefined when no usage shape is found — the caller should fall back
 * to the pre-flight estimate.
 *
 * Hostile-input note: we never throw, never run user-controlled regex,
 * and only deserialize JSON we extracted ourselves from the response.
 * The broker has already verified the upstream is one we issued a
 * secret for, so we trust it not to mount a parse-bomb attack — but
 * the per-event JSON.parse is wrapped so a single malformed event
 * doesn't poison the rest.
 */
export function parseUsageFromUpstream(buf: Buffer | string): ParsedUsage | undefined {
  const text = typeof buf === "string" ? buf : buf.toString("utf8");
  if (text.length === 0) return undefined;
  // Try buffered JSON first (cheap when the body is small and well-formed).
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed = tryParseUsageJson(trimmed);
    if (parsed) return parsed;
  }
  // Fall through to SSE: scan all `data: {...}` lines and keep the LAST
  // one whose payload contains a usage object. SSE may interleave usage
  // with content deltas (Anthropic), and the final usage delta is what
  // the broker bills against.
  let last: ParsedUsage | undefined;
  const lines = text.split("\n");
  for (const line of lines) {
    const idx = line.indexOf("data:");
    if (idx < 0) continue;
    const payload = line.slice(idx + "data:".length).trim();
    if (!payload || payload === "[DONE]" || !payload.startsWith("{")) continue;
    const parsed = tryParseUsageJson(payload);
    if (parsed) last = parsed;
  }
  return last;
}

function tryParseUsageJson(text: string): ParsedUsage | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object") return undefined;
  // Some Anthropic events nest usage under `message.usage`.
  const candidates: unknown[] = [
    (obj as { usage?: unknown }).usage,
    (obj as { message?: { usage?: unknown } }).message?.usage,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const u = c as Record<string, unknown>;
    // OpenAI: prompt_tokens / completion_tokens. Anthropic: input_tokens / output_tokens.
    const inTok = numericField(u, "prompt_tokens") ?? numericField(u, "input_tokens");
    const outTok = numericField(u, "completion_tokens") ?? numericField(u, "output_tokens");
    if (inTok !== undefined && outTok !== undefined) {
      return { inputTokens: inTok, outputTokens: outTok };
    }
  }
  return undefined;
}

function numericField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return v;
}
