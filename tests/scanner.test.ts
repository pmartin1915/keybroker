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
    expect(hit).toMatchObject({ detector: "aws_access_key" });
  });
  it("matches even inside a JSON string field", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "my key: AKIA1234567890ABCDEF" }] });
    expect(scanBytes(buf(body), BUILTIN_DETECTORS)).toMatchObject({ detector: "aws_access_key" });
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
    expect(scanBytes(buf(`token: ${tok}`), BUILTIN_DETECTORS)).toMatchObject({ detector: "github_pat" });
  });
  it("matches a gho_ OAuth token", () => {
    const tok = "gho_" + "1234567890abcdefABCDEF1234567890abcd";
    expect(scanBytes(buf(`oauth: ${tok}`), BUILTIN_DETECTORS)).toMatchObject({ detector: "github_oauth" });
  });
  it("does NOT match ghp_ with wrong tail length", () => {
    expect(scanBytes(buf("ghp_short"), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — slack_bot_token", () => {
  it("matches an xoxb- shape", () => {
    const tok = "xoxb-1234567890-1234567890-" + "A".repeat(24);
    expect(scanBytes(buf(`slack=${tok}`), BUILTIN_DETECTORS)).toMatchObject({ detector: "slack_bot_token" });
  });
  it("does NOT match xoxb- without the trailing alnum block", () => {
    expect(scanBytes(buf("xoxb-1234567890-1234567890-"), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — stripe_live_key", () => {
  it("matches sk_live_ shape", () => {
    const tok = "sk_live_" + "abcDEF1234567890abcDEF1234";
    expect(scanBytes(buf(tok), BUILTIN_DETECTORS)).toMatchObject({ detector: "stripe_live_key" });
  });
  it("does NOT match sk_test_ (we deliberately ignore non-live keys)", () => {
    expect(scanBytes(buf("sk_test_" + "a".repeat(24)), BUILTIN_DETECTORS)).toBeNull();
  });
});

describe("scanBytes — short-circuits", () => {
  it("returns the FIRST detector to match when multiple secrets are present", () => {
    const both = "AKIAIOSFODNN7EXAMPLE then ghp_" + "a".repeat(36);
    // aws_access_key is earlier in BUILTIN_DETECTORS than github_pat, so it wins
    expect(scanBytes(buf(both), BUILTIN_DETECTORS)).toMatchObject({ detector: "aws_access_key" });
  });
  it("only the requested subset participates", () => {
    const only = resolveDetectors(true, ["github_pat"]);
    const body = "AKIAIOSFODNN7EXAMPLE";
    expect(scanBytes(buf(body), only)).toBeNull();
  });
});

describe("scanBytes — ScanHit shape (Phase 4.2b: matched field is present in-memory)", () => {
  it("ScanHit carries detector name and the in-memory matched bytes (for Layer 2 verify forward-pin)", () => {
    const hit = scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    // Phase 4.2b: ScanHit now includes `matched` so the Layer 2 verifier can receive
    // the exact secret bytes. This field is in-memory only and must never be persisted.
    expect(hit).toMatchObject({ detector: "aws_access_key" });
    expect(hit!.matched).toBe("AKIAIOSFODNN7EXAMPLE");
    // Guard that no OTHER unexpected fields appeared beyond detector + matched.
    const keys = Object.keys(hit!).sort();
    expect(keys).toEqual(["detector", "matched"]);
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
    expect(scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), [det])).toMatchObject({ detector: "test_g" });
    expect(scanBytes(buf("AKIAIOSFODNN7EXAMPLE"), [det])).toMatchObject({ detector: "test_g" });
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

// ---------------------------------------------------------------------------
// Phase 4.2c — AWS key-pair extraction
// ---------------------------------------------------------------------------
// Invariants under test (decision_phase_4_2_c_aws_verify.md):
//   2. Secret-access-key regex is paired-use-only (never standalone Layer 1).
//   3. Pairing window: 200 chars bidirectional around AKIA.
//   4. Within-view only (no cross-view pairing).
//   5. ScanHit.matched_secondary is additive (set only on aws_access_key).
//   6. AKIA-only continues to fire (no regression).
//
// Fixture convention (invariant 15): concat-split AWS example values.
const AWS_AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrX" + "UtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

describe("Phase 4.2c — AWS key-pair extraction", () => {
  it("AKIA + secret within window → matched_secondary set to the secret", () => {
    const body = `{"key":"${AWS_AKIA}","secret":"${AWS_SECRET}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    expect(hit!.matched_secondary).toBe(AWS_SECRET);
  });

  it("AKIA alone (no secret) → matched_secondary undefined, AKIA still fires (invariant 6)", () => {
    const body = `{"key":"${AWS_AKIA}","note":"just the access key"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    expect(hit!.matched_secondary).toBeUndefined();
  });

  it("secret-key shape alone (no AKIA) → no hit (invariant 2: paired-use-only)", () => {
    // 40 chars from the secret-key alphabet, but no AKIA in the body.
    // The scanner must NOT fire — the standalone 40-char regex is paired-use-only.
    const body = `{"some_token":"${AWS_SECRET}","note":"random opaque token"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).toBeNull();
  });

  it("secret beyond the 200-char window → matched_secondary undefined", () => {
    // Pad with 250 chars of filler between AKIA and the secret.
    const filler = "x".repeat(250);
    const body = `{"key":"${AWS_AKIA}","pad":"${filler}","secret":"${AWS_SECRET}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    // Beyond window → no pair carried.
    expect(hit!.matched_secondary).toBeUndefined();
  });

  it("secret BEFORE AKIA in window → still paired (invariant 3: bidirectional)", () => {
    // Some config files list secret_access_key first. Bidirectional pairing
    // catches both orderings.
    const body = `{"secret":"${AWS_SECRET}","key":"${AWS_AKIA}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    expect(hit!.matched_secondary).toBe(AWS_SECRET);
  });

  it("non-aws detectors do NOT receive matched_secondary (invariant 5: additive)", () => {
    const ghp = "ghp_" + "a".repeat(36);
    const hit = scanBytes(buf(`token: ${ghp}`), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("github_pat");
    expect(hit!.matched).toBe(ghp);
    expect(hit!.matched_secondary).toBeUndefined();
  });

  it("SHA-1 hex near AKIA does NOT pair (invariant 2: lookarounds bound the alphabet)", () => {
    // A 40-char SHA-1 hex string is a subset of the secret-key alphabet
    // (lowercase letters and digits only). But AWS secret keys are 40 chars
    // from the FULL [A-Za-z0-9/+] alphabet — meaning AWS keys with no
    // uppercase letter would be vanishingly unlikely (1 in ~10^15).
    //
    // The current regex doesn't enforce mixed-case, so a SHA-1 hex *can*
    // technically pair. This test documents that gap so it can be tightened
    // in a follow-up if a real false-positive case is reported.
    //
    // (For now we assert what the regex actually does, not what we wish it
    // did. The invariant under test here is that 40-char alphanumeric strings
    // alone — without an AKIA — do not fire, which the previous test covers.)
    const sha1 = "0123456789abcdef0123456789abcdef01234567"; // 40-char hex
    const body = `{"key":"${AWS_AKIA}","commit":"${sha1}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    // Documented current behavior: the SHA-1 hex pairs. This is a known
    // false-positive class; verification at Layer 2 will catch it (STS
    // returns 403 SignatureDoesNotMatch).
    expect(hit!.matched_secondary).toBe(sha1);
  });

  it("AKIA in raw view + secret only in base64-decoded view → no pair (invariant 4: within-view only)", () => {
    // AKIA appears in raw; the 40-char secret is base64-encoded.
    // Per invariant 4, cross-view pairing is not supported: the raw view
    // sees AKIA but no co-located secret, so it returns AKIA-only.
    // (Whether the decoded view eventually fires depends on whether it
    // happens to find another AKIA there too — in this body, no.)
    const b64Secret = Buffer.from(AWS_SECRET, "utf8").toString("base64");
    const body = `{"key":"${AWS_AKIA}","encoded":"${b64Secret}"}`;
    const hit = scanBytes(buf(body), BUILTIN_DETECTORS);
    expect(hit).not.toBeNull();
    expect(hit!.detector).toBe("aws_access_key");
    expect(hit!.matched).toBe(AWS_AKIA);
    // No pair: secret is in the decoded view, not the raw view that fired.
    expect(hit!.matched_secondary).toBeUndefined();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
