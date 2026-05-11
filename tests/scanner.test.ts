/**
 * Phase 3.6 — scanner module tests.
 *
 * Covers:
 *   - Each built-in detector matches a known-good fixture and rejects
 *     near-misses (wrong prefix, wrong length, embedded in word).
 *   - scanBytes short-circuits on first hit.
 *   - Empty / undefined buffers return null.
 *   - resolveDetectors honors enabled flag, default-all, named subset,
 *     and unknown-name handling.
 *   - **No matched substring leaks**: a hit returns ONLY the detector
 *     name. (Tested by asserting the ScanHit object shape — there is no
 *     field that could carry the secret.)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BUILTIN_DETECTORS,
  getBuiltinDetector,
  resolveDetectors,
  scanBytes,
  type Detector,
} from "../src/scanner.js";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("BUILTIN_DETECTORS", () => {
  it("all patterns are global (so lastIndex reset is meaningful)", () => {
    for (const d of BUILTIN_DETECTORS) {
      expect(d.pattern.flags).toContain("g");
    }
  });
  it("names are unique", () => {
    const names = BUILTIN_DETECTORS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("getBuiltinDetector", () => {
  it("returns the detector for a known name", () => {
    expect(getBuiltinDetector("aws_access_key")?.name).toBe("aws_access_key");
  });
  it("returns undefined for unknown names", () => {
    expect(getBuiltinDetector("not_a_real_detector")).toBeUndefined();
  });
});

describe("scanBytes — empty inputs", () => {
  it("returns null for undefined buffer", () => {
    expect(scanBytes(undefined, BUILTIN_DETECTORS)).toBeNull();
  });
  it("returns null for empty buffer", () => {
    expect(scanBytes(Buffer.alloc(0), BUILTIN_DETECTORS)).toBeNull();
  });
  it("returns null when no detectors are configured", () => {
    expect(scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), [])).toBeNull();
  });
});

describe("scanBytes — aws_access_key", () => {
  it("matches a real-shape AKIA key", () => {
    // 20 chars total: AKIA + 16 of [0-9A-Z]
    const hit = scanBytes(buf("here is a key AKIAIOSFODNN7EXAMPLE in prose"), BUILTIN_DETECTORS);
    expect(hit).toEqual({ detector: "aws_access_key" });
  });
  it("matches even inside a JSON string field", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "my key: AKIA1234567890ABCDEF" }] });
    expect(scanBytes(buf(body), BUILTIN_DETECTORS)).toEqual({ detector: "aws_access_key" });
  });
  it("does NOT match shorter near-misses", () => {
    expect(scanBytes(buf("AKIA1234"), BUILTIN_DETECTORS)).toBeNull();
  });
  it("does NOT match lowercase variants", () => {
    expect(scanBytes(buf("akiaiosfodnn7example"), BUILTIN_DETECTORS)).toBeNull();
  });
  it("does NOT match when joined with no word boundary on either side", () => {
    // 21 chars of [A-Z0-9] starting with AKIA -> word boundary at end fails
    expect(scanBytes(buf("ZAKIAIOSFODNN7EXAMPLE"), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — github_pat / github_oauth", () => {
  it("matches a ghp_ classic PAT", () => {
    const tok = "ghp_" + "a".repeat(36);
    expect(scanBytes(buf(`token: ${tok}`), BUILTIN_DETECTORS)).toEqual({ detector: "github_pat" });
  });
  it("matches a gho_ OAuth token", () => {
    const tok = "gho_" + "1234567890abcdefABCDEF1234567890abcd";
    expect(scanBytes(buf(`oauth: ${tok}`), BUILTIN_DETECTORS)).toEqual({ detector: "github_oauth" });
  });
  it("does NOT match ghp_ with wrong tail length", () => {
    expect(scanBytes(buf("ghp_short"), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — slack_bot_token", () => {
  it("matches an xoxb- shape", () => {
    const tok = "xoxb-1234567890-1234567890-" + "A".repeat(24);
    expect(scanBytes(buf(`slack=${tok}`), BUILTIN_DETECTORS)).toEqual({ detector: "slack_bot_token" });
  });
  it("does NOT match xoxb- without the trailing alnum block", () => {
    expect(scanBytes(buf("xoxb-1234567890-1234567890-"), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — stripe_live_key", () => {
  it("matches sk_live_ shape", () => {
    const tok = "sk_live_" + "abcDEF1234567890abcDEF1234";
    expect(scanBytes(buf(tok), BUILTIN_DETECTORS)).toEqual({ detector: "stripe_live_key" });
  });
  it("does NOT match sk_test_ (we deliberately ignore non-live keys)", () => {
    expect(scanBytes(buf("sk_test_" + "a".repeat(24)), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — short-circuits", () => {
  it("returns the FIRST detector to match when multiple secrets are present", () => {
    const both = "AKIAIOSFODNN7EXAMPLE then ghp_" + "a".repeat(36);
    // aws_access_key is earlier in BUILTIN_DETECTORS than github_pat, so it wins
    expect(scanBytes(buf(both), BUILTIN_DETECTORS)).toEqual({ detector: "aws_access_key" });
  });
  it("only the requested subset participates", () => {
    const only = resolveDetectors(true, ["github_pat"]);
    const body = "AKIAIOSFODNN7EXAMPLE";
    expect(scanBytes(buf(body), only)).toBeNull();
  });
});

describe("scanBytes — does not leak the matched substring", () => {
  it("ScanHit shape carries only the detector name (no `match`/`text` field)", () => {
    const hit = scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    // The exported type guarantees no `match` field, but assert at runtime
    // too so a future contributor adding one trips this test.
    expect(Object.keys(hit!)).toEqual(["detector"]);
  });
});

describe("scanBytes — pattern lastIndex hygiene", () => {
  it("two consecutive scans of different bodies don't share regex state", () => {
    // If lastIndex weren't reset between scans, the second call could
    // return null on a body that starts before where the first call's
    // exec position landed.
    const det: Detector = {
      name: "test_g",
      pattern: /AKIA[0-9A-Z]{16}/g,
      description: "test",
    };
    expect(scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), [det])).toEqual({ detector: "test_g" });
    expect(scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), [det])).toEqual({ detector: "test_g" });
  });
});

describe("resolveDetectors", () => {
  it("returns [] when disabled", () => {
    expect(resolveDetectors(false, undefined)).toEqual([]);
    expect(resolveDetectors(false, ["aws_access_key"])).toEqual([]);
  });
  it("returns all built-ins when wantedNames is undefined", () => {
    const r = resolveDetectors(true, undefined);
    expect(r).toBe(BUILTIN_DETECTORS); // identity, not a copy
  });
  it("returns all built-ins when wantedNames is empty", () => {
    expect(resolveDetectors(true, [])).toBe(BUILTIN_DETECTORS);
  });
  it("returns only the named subset", () => {
    const r = resolveDetectors(true, ["aws_access_key", "github_pat"]);
    expect(r.map((d) => d.name)).toEqual(["aws_access_key", "github_pat"]);
  });

  it("warns and skips unknown names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = resolveDetectors(true, ["aws_access_key", "nope_not_real"]);
    expect(r.map((d) => d.name)).toEqual(["aws_access_key"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/unknown detector/);
    warn.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
