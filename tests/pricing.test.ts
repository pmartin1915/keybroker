import { describe, it, expect } from "vitest";
import {
  priceForModel,
  estimateOutputCostUsd,
  actualCostUsd,
  parseUsageFromUpstream,
  PRICING,
} from "../src/pricing.js";

describe("priceForModel: glob lookup ordering", () => {
  it("returns a price for an exact OpenAI model name", () => {
    expect(priceForModel("gpt-4o-mini")).toBeDefined();
    expect(priceForModel("gpt-4o")).toBeDefined();
  });

  it("most specific glob wins over a broader one", () => {
    // PRICING declares `gpt-4o-mini*` BEFORE `gpt-4o*`. A naive lookup that
    // walked the broad pattern first would mis-price gpt-4o-mini at the
    // gpt-4o tier — almost 17x too expensive. This pins the ordering.
    const mini = priceForModel("gpt-4o-mini");
    const big = priceForModel("gpt-4o");
    expect(mini).toBeDefined();
    expect(big).toBeDefined();
    expect(mini!.inputUsdPerMTok).toBeLessThan(big!.inputUsdPerMTok);
  });

  it("returns a price for an Anthropic model name", () => {
    const opus = priceForModel("claude-opus-4-7-20251205");
    expect(opus).toBeDefined();
    expect(opus!.outputUsdPerMTok).toBeGreaterThan(opus!.inputUsdPerMTok);
  });

  it("returns undefined for an unknown model", () => {
    expect(priceForModel("totally-fake-model-9000")).toBeUndefined();
    expect(priceForModel("")).toBeUndefined();
  });

  it("PRICING table is non-empty (regression: don't ship an empty fleet)", () => {
    expect(PRICING.length).toBeGreaterThan(0);
  });

  it("prices the gemini/mistral models the dispatcher actually mints for", () => {
    // Phase 3.2 c4 smoke (2026-05-11) found capped dispatcher tokens were
    // 403ing as `cap_unpriced_model` because these patterns were missing.
    // The dispatcher hardcodes a $5 cap on every mint — any unpriced model
    // here silently breaks broker routing for that provider.
    expect(priceForModel("gemini-2.5-flash")).toBeDefined();
    expect(priceForModel("gemini-2.5-pro")).toBeDefined();
    expect(priceForModel("mistral-large-latest")).toBeDefined();
    expect(priceForModel("mistral-small-latest")).toBeDefined();
    expect(priceForModel("codestral-latest")).toBeDefined();
  });
});

describe("estimateOutputCostUsd: pre-flight estimate", () => {
  it("returns undefined for an unknown model", () => {
    expect(estimateOutputCostUsd({ model: "x", maxTokens: 100 })).toBeUndefined();
  });

  it("treats missing maxTokens as 0 output tokens (gives 0 cost when input is also 0)", () => {
    // Conservative bound — a body without max_tokens charges only the
    // (default 0) input. The test pins the policy: undefined max_tokens
    // does NOT default to some "typical" output size, because that would
    // let a malicious caller dodge the cap by omitting the field.
    const c = estimateOutputCostUsd({ model: "gpt-4o-mini" });
    expect(c).toBe(0);
  });

  it("computes input + output cost when both are provided", () => {
    const price = priceForModel("gpt-4o-mini")!;
    const c = estimateOutputCostUsd({
      model: "gpt-4o-mini",
      inputTokens: 1_000_000,
      maxTokens: 1_000_000,
    });
    expect(c).toBeCloseTo(price.inputUsdPerMTok + price.outputUsdPerMTok, 6);
  });

  it("scales linearly with token counts", () => {
    const small = estimateOutputCostUsd({ model: "gpt-4o-mini", maxTokens: 1000 })!;
    const big = estimateOutputCostUsd({ model: "gpt-4o-mini", maxTokens: 2000 })!;
    expect(big).toBeCloseTo(small * 2, 6);
  });
});

describe("actualCostUsd: post-call cost from usage", () => {
  it("returns undefined for an unknown model", () => {
    expect(
      actualCostUsd({ model: "x", inputTokens: 100, outputTokens: 50 }),
    ).toBeUndefined();
  });

  it("computes from input + output token counts", () => {
    const price = priceForModel("gpt-4o-mini")!;
    const c = actualCostUsd({
      model: "gpt-4o-mini",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    })!;
    expect(c).toBeCloseTo(
      price.inputUsdPerMTok + 0.5 * price.outputUsdPerMTok,
      6,
    );
  });
});

describe("parseUsageFromUpstream: shape detection", () => {
  it("parses an OpenAI-style buffered JSON body", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    expect(parseUsageFromUpstream(body)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it("parses an Anthropic-style buffered JSON body", () => {
    const body = JSON.stringify({
      id: "msg_1",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 7, output_tokens: 14 },
    });
    expect(parseUsageFromUpstream(body)).toEqual({
      inputTokens: 7,
      outputTokens: 14,
    });
  });

  it("parses an OpenAI SSE final usage event", () => {
    const sse = [
      'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}',
      "",
      'data: {"id":"x","choices":[{"delta":{"content":"!"}}]}',
      "",
      'data: {"id":"x","usage":{"prompt_tokens":3,"completion_tokens":4}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(parseUsageFromUpstream(sse)).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  it("parses an Anthropic SSE message_delta usage event nested under message", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"x","usage":{"input_tokens":11,"output_tokens":2}}}',
      "",
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
      "",
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"input_tokens":11,"output_tokens":22}}',
      "",
    ].join("\n");
    // The LAST usage event wins (Anthropic emits a streaming start usage
    // and a final usage; we want the final).
    expect(parseUsageFromUpstream(sse)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  it("returns undefined when no usage shape is present", () => {
    expect(parseUsageFromUpstream("")).toBeUndefined();
    expect(parseUsageFromUpstream("not json")).toBeUndefined();
    expect(
      parseUsageFromUpstream(JSON.stringify({ choices: [] })),
    ).toBeUndefined();
  });

  it("ignores malformed SSE events without throwing", () => {
    const sse = [
      "data: {oops malformed",
      "",
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}',
      "",
    ].join("\n");
    expect(parseUsageFromUpstream(sse)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it("rejects non-numeric token counts (defensive)", () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: "lots", completion_tokens: 5 },
    });
    expect(parseUsageFromUpstream(body)).toBeUndefined();
  });
});
