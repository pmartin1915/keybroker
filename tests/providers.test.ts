import { describe, it, expect } from "vitest";
import { getProvider, PROVIDERS } from "../src/providers/index.js";

describe("providers registry", () => {
  it("registers openai, anthropic, gemini, mistral, echo", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual([
      "anthropic",
      "echo",
      "gemini",
      "mistral",
      "openai",
    ]);
  });

  it("getProvider returns undefined for unknown providers", () => {
    expect(getProvider("nope")).toBeUndefined();
  });

  it("anthropic uses header auth with x-api-key", () => {
    const spec = getProvider("anthropic")!;
    expect(spec.authStyle).toBe("header");
    expect(spec.authHeader).toBe("x-api-key");
  });

  it("gemini uses header auth with x-goog-api-key", () => {
    const spec = getProvider("gemini")!;
    expect(spec.authStyle).toBe("header");
    expect(spec.authHeader).toBe("x-goog-api-key");
    expect(spec.baseUrl).toBe("https://generativelanguage.googleapis.com");
  });

  it("mistral uses bearer auth", () => {
    const spec = getProvider("mistral")!;
    expect(spec.authStyle).toBe("bearer");
    expect(spec.baseUrl).toBe("https://api.mistral.ai");
  });
});

describe("jsonRequestMetadata (openai/anthropic/mistral/echo shape)", () => {
  const extract = (path: string, body: Buffer | undefined, method = "POST") =>
    getProvider("openai")!.extractRequestMetadata!({ body, path, method });

  it("returns no-body for empty buffer", () => {
    expect(extract("/v1/chat/completions", undefined)).toEqual({ kind: "no-body" });
    expect(extract("/v1/chat/completions", Buffer.alloc(0))).toEqual({ kind: "no-body" });
  });

  it("returns unparseable for non-JSON bodies", () => {
    expect(extract("/v1/chat/completions", Buffer.from("not json"))).toEqual({
      kind: "unparseable",
    });
  });

  it("returns no-model when JSON is missing the model field", () => {
    expect(
      extract("/v1/chat/completions", Buffer.from(JSON.stringify({ messages: [] }))),
    ).toEqual({ kind: "no-model" });
  });

  it("returns ok with model + stream + max_tokens", () => {
    const result = extract(
      "/v1/chat/completions",
      Buffer.from(
        JSON.stringify({ model: "gpt-4", stream: true, max_tokens: 256 }),
      ),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gpt-4", stream: true, maxTokens: 256 },
    });
  });

  it("prefers max_completion_tokens over max_tokens", () => {
    const result = extract(
      "/v1/chat/completions",
      Buffer.from(
        JSON.stringify({ model: "gpt-4", max_completion_tokens: 100, max_tokens: 50 }),
      ),
    );
    expect(result).toEqual({ kind: "ok", meta: { model: "gpt-4", maxTokens: 100 } });
  });

  it("works the same for mistral (shares jsonRequestMetadata)", () => {
    const mistral = getProvider("mistral")!.extractRequestMetadata!;
    const result = mistral({
      body: Buffer.from(JSON.stringify({ model: "mistral-large-latest" })),
      path: "/v1/chat/completions",
      method: "POST",
    });
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "mistral-large-latest" },
    });
  });

  it("ignores path and method (body-only providers)", () => {
    // OpenAI extractor should yield the same result regardless of path.
    const body = Buffer.from(JSON.stringify({ model: "gpt-4" }));
    const a = extract("/v1/chat/completions", body, "POST");
    const b = extract("/some/other/path", body, "POST");
    expect(a).toEqual(b);
  });
});

describe("geminiRequestMetadata", () => {
  const extract = (path: string, body: Buffer | undefined, method = "POST") =>
    getProvider("gemini")!.extractRequestMetadata!({ body, path, method });

  it("returns no-body for empty buffer", () => {
    expect(extract("/v1beta/models/gemini-2.5-pro:generateContent", undefined)).toEqual({
      kind: "no-body",
    });
  });

  it("extracts model from generateContent path", () => {
    const result = extract(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      Buffer.from(JSON.stringify({ contents: [] })),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gemini-2.5-pro", stream: false },
    });
  });

  it("detects stream action from path suffix", () => {
    const result = extract(
      "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
      Buffer.from(JSON.stringify({ contents: [] })),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gemini-2.5-flash", stream: true },
    });
  });

  it("reads generationConfig.maxOutputTokens", () => {
    const result = extract(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      Buffer.from(
        JSON.stringify({
          contents: [],
          generationConfig: { maxOutputTokens: 1024 },
        }),
      ),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gemini-2.5-pro", stream: false, maxTokens: 1024 },
    });
  });

  it("returns no-model when path doesn't match models/<name>:<action>", () => {
    const result = extract(
      "/v1beta/something/else",
      Buffer.from(JSON.stringify({ foo: "bar" })),
    );
    expect(result).toEqual({ kind: "no-model" });
  });

  it("returns unparseable when body is not JSON even when path has model", () => {
    // Fail closed: a malformed body on a model-restricted token should not
    // ride through just because the path looks valid.
    const result = extract(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      Buffer.from("not json at all"),
    );
    expect(result).toEqual({ kind: "unparseable" });
  });

  it("ignores generationConfig.maxOutputTokens when not a finite number", () => {
    const result = extract(
      "/v1beta/models/gemini-2.5-pro:generateContent",
      Buffer.from(
        JSON.stringify({
          contents: [],
          generationConfig: { maxOutputTokens: "lots" },
        }),
      ),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gemini-2.5-pro", stream: false },
    });
  });

  it("handles tuned-model path shape (publishers/<id>/models/<name>)", () => {
    // Tuned models live under publishers/google/models/<name>. The regex
    // tolerates one or more path segments between /v1beta and /models/.
    const result = extract(
      "/v1beta/publishers/google/models/gemini-2.5-pro:generateContent",
      Buffer.from(JSON.stringify({ contents: [] })),
    );
    expect(result).toEqual({
      kind: "ok",
      meta: { model: "gemini-2.5-pro", stream: false },
    });
  });
});
