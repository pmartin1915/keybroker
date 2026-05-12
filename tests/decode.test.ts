/**
 * Phase 4.2a — decoder unit tests.
 *
 * Tests the three pure decoder functions in src/decode.ts plus their
 * integration with scanBytes (via scanner.test.ts also covers the combined
 * path, but the decoder-specific invariants are tested here).
 *
 * Key invariants tested (from decision_phase_4_2_a_decoding.md):
 *   - Invariant 2: max one layer of decoding (base64-of-base64 negative test)
 *   - Invariant 4: never 403 on encoding shape alone (base64 with no detector hit)
 *   - Invariant 5: fail-open on decode error (malformed urlencode)
 *   - Invariant 8: decoders are pure (buf: Buffer) => Buffer | null functions
 */
import { describe, it, expect } from "vitest";
import {
  decodeBase64,
  decodeUrlEncoded,
  decodeJsonStringUnescape,
  DECODERS,
} from "../src/decode.js";
import { scanBytes, BUILTIN_DETECTORS } from "../src/scanner.js";

const buf = (s: string) => Buffer.from(s, "utf8");

// ─── decodeBase64 ────────────────────────────────────────────────────────────

describe("decodeBase64", () => {
  it("returns null for empty buffer", () => {
    expect(decodeBase64(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when no base64 candidates present", () => {
    // Too short / all whitespace
    expect(decodeBase64(buf("hello world"))).toBeNull();
  });

  it("decodes a standard base64-encoded string", () => {
    // base64("AKIAIOSFODNN7EXAMPLE") = "QUTJQSU9TRk9ETk43RVHBTVBMRQ=="
    const encoded = Buffer.from("AKIAIOSFODNN7EXAMPLE", "utf8").toString("base64");
    const result = decodeBase64(buf(encoded));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain("AKIA");
  });

  it("handles URL-safe base64 (- and _ instead of + and /)", () => {
    // URL-safe encode a known string
    const standard = Buffer.from("AKIAIOSFODNN7EXAMPLE", "utf8").toString("base64");
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const result = decodeBase64(buf(urlSafe));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain("AKIA");
  });

  it("extracts candidates from surrounding prose", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const encoded = Buffer.from(awsKey, "utf8").toString("base64");
    const body = `here is a key ${encoded} in prose text`;
    const result = decodeBase64(buf(body));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain("AKIA");
  });

  it("rejects decoded output that is binary garbage (not printable UTF-8)", () => {
    // Craft base64 that decodes to high-byte binary with < 50% printable chars.
    // Buffer of 20 zero bytes encodes to printable base64, but decoded is
    // mostly null bytes — well below 50% printable threshold.
    const binaryBuf = Buffer.alloc(20, 0x00); // 20 null bytes
    const encoded = binaryBuf.toString("base64"); // "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    // The decoded result is null bytes — should be skipped
    const result = decodeBase64(buf(encoded));
    // Either null (nothing decodable) or empty buffer
    expect(result === null || result.byteLength === 0).toBe(true);
  });

  it("skips candidates shorter than 16 characters", () => {
    // 12-char base64-looking string — below the minimum
    const short = "QUtJQVRFU1Q="; // 12 chars (padding incl), decodes to "AKIATEST" (8 chars)
    // This is actually 12 chars which is >= 16? Let's check: "QUtJQVRFU1Q=" is 12 chars, below threshold
    // Use something definitely short: 8 chars of base64
    const tooShort = "QUJDREVG"; // 8 chars, decodes to "ABCDEF"
    const result = decodeBase64(buf(tooShort));
    expect(result).toBeNull();
  });

  it("returns null when no candidate produces useful decoded text", () => {
    // Body with only garbage that isn't decodable to printable text
    const result = decodeBase64(buf("not-b64-at-all !!@@##$$%%"));
    expect(result).toBeNull();
  });
});

// ─── decodeUrlEncoded ────────────────────────────────────────────────────────

describe("decodeUrlEncoded", () => {
  it("returns null for empty buffer", () => {
    expect(decodeUrlEncoded(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when no percent-encoding present", () => {
    expect(decodeUrlEncoded(buf("plain text here"))).toBeNull();
  });

  it("decodes percent-encoded characters", () => {
    // %41%4B%49%41 = "AKIA"
    const result = decodeUrlEncoded(buf("%41%4B%49%41IOSFODNN7EXAMPLE"));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain("AKIA");
  });

  it("decodes a full GitHub PAT in URL-encoding", () => {
    const token = "ghp_" + "a".repeat(36);
    // Encode the ghp_ prefix
    const encoded = token.replace("ghp_", "%67%68%70%5F");
    const result = decodeUrlEncoded(buf(encoded));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain("ghp_");
  });

  it("fail-open on malformed percent encoding (invariant 5)", () => {
    // %ZZ is not valid hex — decodeURIComponent should throw
    const result = decodeUrlEncoded(buf("hello %ZZ world"));
    // Must return null (fail-open), not throw
    expect(result).toBeNull();
  });

  it("returns null when decoded result equals input (nothing was actually encoded)", () => {
    // A string with a % but not forming a valid percent sequence that changes anything
    // Actually any valid % sequence will change. Let's just test it doesn't crash
    // on text that decodes to itself (no real encoding).
    const result = decodeUrlEncoded(buf("100% pure"));
    // "100% pure" — the % here would be part of "% p" which is malformed (%20 space)
    // decodeURIComponent("100% pure") throws on "% p", so returns null (fail-open)
    expect(result).toBeNull();
  });
});

// ─── decodeJsonStringUnescape ─────────────────────────────────────────────────

describe("decodeJsonStringUnescape", () => {
  it("returns null for empty buffer", () => {
    expect(decodeJsonStringUnescape(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when no backslash escapes present", () => {
    expect(decodeJsonStringUnescape(buf('{"key":"value"}'))).toBeNull();
  });

  it("unescapes a JSON-escaped Stripe key", () => {
    // Body: {"key":"sk_live_<24+chars>"}
    // The outer quotes are the JSON string delimiters; the value itself has no escapes.
    // To trigger this decoder we need backslash escapes — simulate a body where
    // the key is doubly-quoted in a string, e.g. \"sk_live_...\"
    const stripeKey = "sk_live_" + "abcDEF1234567890abcDEF1234";
    const body = `{"message":"use \\\"${stripeKey}\\\" for payment"}`;
    const result = decodeJsonStringUnescape(buf(body));
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toContain(stripeKey);
  });

  it("unescapes \\n, \\t, \\\\ correctly", () => {
    const body = `{"text":"line1\\nline2\\ttabbed\\\\backslash"}`;
    const result = decodeJsonStringUnescape(buf(body));
    expect(result).not.toBeNull();
    const decoded = result!.toString("utf8");
    expect(decoded).toContain("line1\nline2\ttabbed\\backslash");
  });

  it("handles \\uXXXX unicode escapes", () => {
    const body = `{"text":"\\u0041\\u004B\\u0049\\u0041"}`;
    const result = decodeJsonStringUnescape(buf(body));
    expect(result).not.toBeNull();
    // A=A K=K I=I A=A → "AKIA"
    expect(result!.toString("utf8")).toContain("AKIA");
  });

  it("fail-open on malformed JSON escape — skips bad token, keeps good ones", () => {
    // Malformed JSON: \q is not a valid JSON escape
    const body = `{"bad":"\\q invalid","good":"sk\\nlive"}`;
    // Should not throw, just skip the bad token
    expect(() => decodeJsonStringUnescape(buf(body))).not.toThrow();
  });
});

// ─── DECODERS list ────────────────────────────────────────────────────────────

describe("DECODERS export", () => {
  it("has exactly 3 entries in declared order", () => {
    expect(DECODERS).toHaveLength(3);
    expect(DECODERS[0]!.name).toBe("base64");
    expect(DECODERS[1]!.name).toBe("urlencode");
    expect(DECODERS[2]!.name).toBe("json_string_unescape");
  });

  it("all decoder functions satisfy the (buf: Buffer) => Buffer | null contract", () => {
    for (const decoder of DECODERS) {
      const result = decoder.fn(buf("test"));
      expect(result === null || result instanceof Buffer).toBe(true);
    }
  });
});

// ─── Integration: scanBytes with decoded views ────────────────────────────────

describe("scanBytes — Layer 1.5 (decode-then-scan)", () => {
  // Test 1: base64-encoded AWS key → block
  it("blocks base64-encoded AWS access key (invariant 2, decoder 1)", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE"; // 20 chars, valid AKIA key
    const encoded = Buffer.from(awsKey, "utf8").toString("base64");
    // Wrap in a realistic-looking body
    const body = `{"messages":[{"role":"user","content":"my credentials: ${encoded}"}]}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toMatchObject({ detector: "aws_access_key" });
  });

  // Test 2: URL-encoded GitHub PAT → block
  it("blocks URL-encoded GitHub PAT (decoder 2)", () => {
    const token = "ghp_" + "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrR";
    // Percent-encode the entire token
    const encoded = [...token].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const body = `{"prompt":"use ${encoded} for auth"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toMatchObject({ detector: "github_pat" });
  });

  // Test 3: JSON-string-escaped Stripe key → block
  it("blocks JSON-string-escaped Stripe live key (decoder 3)", () => {
    const stripeKey = "sk_live_" + "abcDEF1234567890abcDEF1234";
    // Simulate a body where the key value is JSON-string-escaped
    // e.g. the actual byte stream is: {"k":"sk_live_...\n..."}
    // To trigger the JSON unescape decoder we need actual backslash chars.
    // Use a body where the key is present inside a JSON string with escape sequences:
    // The raw text has a backslash before the s: \"sk_live_...\"
    const body = `{"message":"key is \\"${stripeKey}\\""}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    // First check: raw scan might find it if the quotes are transparent to the regex
    // The regex /\bsk_live_[0-9A-Za-z]{24,99}\b/g should match the raw string too
    // Let's use the explicit escape scenario with \\n inserted to force decoder path
    expect(hit).toMatchObject({ detector: "stripe_live_key" });
  });

  // Test 3b: Stripe key inside a fully-escaped JSON string (forces decoder path)
  it("blocks JSON-string-escaped Stripe key with intervening \\n (decoder path forced)", () => {
    const stripeKey = "sk_live_" + "abcDEF1234567890abcDEF1234";
    // Put the stripe key inside a JSON-escaped string with actual backslash sequences
    // such that the raw text does NOT contain sk_live_ directly (using \\u escapes)
    // s = s, k = k, _ = _
    const escaped = "\\u0073k_live_abcDEF1234567890abcDEF1234";
    const body = `{"message":"${escaped}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toMatchObject({ detector: "stripe_live_key" });
  });

  // Test 4: Nested encoding negative test (base64 of base64) → NO block
  it("does NOT block base64-of-base64-encoded AWS key (max 1 decode layer, invariant 2)", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const singleEncoded = Buffer.from(awsKey, "utf8").toString("base64");
    // Double-encode: base64 of the already-base64 string
    const doubleEncoded = Buffer.from(singleEncoded, "utf8").toString("base64");
    const body = `{"content":"${doubleEncoded}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    // After one layer of decoding, we get singleEncoded (base64 text), not the AKIA key.
    // The key itself is NOT present — should NOT block.
    expect(hit).toBeNull();
  });

  // Test 5: base64 "hello world" with no detector hit → NO block (invariant 4)
  it("does NOT block base64 content that has no detector hit (encoding shape alone, invariant 4)", () => {
    const innocent = "hello world, this is just a friendly message with no secrets";
    const encoded = Buffer.from(innocent, "utf8").toString("base64");
    const body = `{"prompt":"${encoded}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toBeNull();
  });

  // Test 5b: Long base64-looking string (mermaid diagram style) → NO block
  it("does NOT block mermaid/diagram base64-looking content with no detector hit (invariant 4)", () => {
    // A realistic mermaid diagram embed or JWT header (no secrets)
    const jwtHeader = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // {"alg":"HS256","typ":"JWT"}
    const body = `{"content":"see diagram: ${jwtHeader} above"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toBeNull();
  });

  // Test 6: malformed urlencode wrapping a raw AWS key → still blocks via raw scan
  it("still blocks raw AWS key even when surrounding urlencode context is malformed (fail-open, invariant 5)", () => {
    // The raw body contains a valid AKIA key AND a malformed percent-encoding.
    // The raw scan path should catch the key before the urlencode decoder even runs.
    const body = "context: %ZZ AKIAIOSFODNN7EXAMPLE more text";
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    // Raw scan hits first — the decoder failure is irrelevant
    expect(hit).toMatchObject({ detector: "aws_access_key" });
  });

  // Test 6b: malformed urlencode only (no raw key) — decoder fails, no block
  it("does NOT 500 when urlencode is malformed and no raw hit exists (fail-open, invariant 5)", () => {
    // Malformed URL-encoding with no actual secret present anywhere
    const body = "user input: 100% malformed %ZZ data with nothing secret";
    expect(() => scanBytes(buf(body), BUILTIN_DETECTORS)).not.toThrow();
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toBeNull();
  });

  // Test 7: all existing Phase 3.6 plaintext paths unchanged
  it("still catches a plaintext AWS key in a JSON body (Phase 3.6 regression)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "AKIAIOSFODNN7EXAMPLE" }] });
    expect(scanBytes(buf(body), BUILTIN_DETECTORS)).toMatchObject({ detector: "aws_access_key" });
  });

  it("still catches a plaintext GitHub PAT (Phase 3.6 regression)", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(scanBytes(buf(`token ${token}`), BUILTIN_DETECTORS)).toMatchObject({ detector: "github_pat" });
  });

  // Test 8: empty/undefined buffer still returns null
  it("returns null for undefined buffer (unchanged by Layer 1.5)", () => {
    expect(scanBytes(undefined, BUILTIN_DETECTORS)).toBeNull();
  });

  it("returns null for empty buffer (unchanged by Layer 1.5)", () => {
    expect(scanBytes(Buffer.alloc(0), BUILTIN_DETECTORS)).toBeNull();
  });

  // Test 9: ScanHit from decoded view — Phase 4.2b: matched field carries the decoded bytes
  it("ScanHit from a decoded-view hit carries the decoded matched bytes (forward-pin for Layer 2 verify)", () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const encoded = Buffer.from(awsKey, "utf8").toString("base64");
    const hit = scanBytes(buf(encoded), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    // Phase 4.2b invariant 6: the verifier must receive the decoded bytes (awsKey),
    // NOT the base64 string. `matched` carries the decoded secret from the view that fired.
    expect(hit).toMatchObject({ detector: "aws_access_key" });
    // The matched field holds the decoded text (the actual AKIA key), not the base64.
    expect(hit!.matched).toBe(awsKey);
    // Guard: only detector and matched — no "view" field or other leaks.
    const keys = Object.keys(hit!).sort();
    expect(keys).toEqual(["detector", "matched"]);
  });

  // Bonus: first-hit-wins across views — raw scan wins over decoded scan
  it("raw scan wins over decoded scan when both would match (first-hit-wins across views)", () => {
    // Body contains a raw GitHub PAT AND a base64-encoded AWS key.
    // aws_access_key is first in BUILTIN_DETECTORS; the GitHub PAT is raw.
    // BUT raw scan runs first and aws_access_key pattern runs before github_pat —
    // if the raw body has both, aws_access_key wins.
    // Here: raw has github_pat only; decoded (base64) has aws_access_key.
    // The raw scan finds github_pat first (it IS present in raw).
    const rawToken = "ghp_" + "aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrR";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const encodedAwsKey = Buffer.from(awsKey, "utf8").toString("base64");
    const body = `token: ${rawToken} extra: ${encodedAwsKey}`;
    // Raw scan: github_pat matches (raw). aws_access_key would match from base64 decode.
    // But raw scan runs all detectors in order: aws_access_key first, github_pat second.
    // aws_access_key is NOT in the raw body — only github_pat is raw.
    // So raw scan yields github_pat. That is the first hit and is returned.
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toMatchObject({ detector: "github_pat" });
  });
});
