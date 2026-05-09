import { describe, it, expect } from "vitest";
import {
  scopeAllows,
  issueToken,
  verifyToken,
  TOKEN_PREFIX,
} from "../src/tokens.js";
import { generateJwtSecret } from "../src/crypto.js";

const SECRET = generateJwtSecret();

describe("scopeAllows: exact + prefix matching", () => {
  it("allows exact method+path match", () => {
    expect(scopeAllows(["POST:/v1/foo"], "POST", "/v1/foo")).toBe(true);
  });

  it("allows method match across case", () => {
    expect(scopeAllows(["post:/v1/foo"], "POST", "/v1/foo")).toBe(true);
    expect(scopeAllows(["POST:/v1/foo"], "post", "/v1/foo")).toBe(true);
  });

  it("allows prefix at a segment boundary", () => {
    expect(scopeAllows(["POST:/v1/foo"], "POST", "/v1/foo/bar")).toBe(true);
  });

  it("allows when scope prefix already ends in slash", () => {
    expect(scopeAllows(["POST:/v1/"], "POST", "/v1/anything")).toBe(true);
  });

  it("allows wildcard scope `*`", () => {
    expect(scopeAllows(["*"], "DELETE", "/anywhere")).toBe(true);
  });

  it("allows method wildcard", () => {
    expect(scopeAllows(["*:/v1/foo"], "PATCH", "/v1/foo")).toBe(true);
  });

  it("allows path wildcard within a method", () => {
    expect(scopeAllows(["GET:*"], "GET", "/whatever/path")).toBe(true);
  });
});

describe("scopeAllows: regression — boundary attack", () => {
  // Audit fix in commit 8611805: scope `POST:/v1/foo` MUST NOT match
  // `/v1/foobar`. Previously a naive startsWith would have allowed it.
  it("denies prefix-without-boundary (foo vs foobar)", () => {
    expect(scopeAllows(["POST:/v1/foo"], "POST", "/v1/foobar")).toBe(false);
  });

  it("denies prefix-without-boundary on chat-completions example", () => {
    expect(
      scopeAllows(
        ["POST:/v1/chat/completions"],
        "POST",
        "/v1/chat/completionsEVIL",
      ),
    ).toBe(false);
  });
});

describe("scopeAllows: regression — `..` segments", () => {
  // Audit fix in commit 8611805: any path containing a `..` segment
  // is denied unconditionally, even if the prefix would otherwise match.
  it("denies a path with a `..` segment even under wildcard", () => {
    expect(scopeAllows(["*"], "GET", "/v1/../etc/passwd")).toBe(false);
  });

  it("denies a path with a `..` segment under matching scope", () => {
    expect(scopeAllows(["GET:/v1/"], "GET", "/v1/../secret")).toBe(false);
  });

  it("does not deny paths that merely contain `..` inside a segment", () => {
    // `/v1/..foo` is a literal segment, not traversal — still allowed.
    expect(scopeAllows(["GET:/v1/"], "GET", "/v1/..foo")).toBe(true);
  });
});

describe("scopeAllows: misc denies", () => {
  it("denies on method mismatch", () => {
    expect(scopeAllows(["POST:/v1/foo"], "GET", "/v1/foo")).toBe(false);
  });

  it("denies on path mismatch", () => {
    expect(scopeAllows(["POST:/v1/foo"], "POST", "/v2/foo")).toBe(false);
  });

  it("denies when scope list is empty", () => {
    expect(scopeAllows([], "GET", "/x")).toBe(false);
  });

  it("ignores malformed scope entries (no colon)", () => {
    expect(scopeAllows(["malformed"], "GET", "/x")).toBe(false);
  });
});

describe("issueToken / verifyToken round-trip", () => {
  it("verifies a freshly issued token", async () => {
    const raw = await issueToken(SECRET, {
      tokenId: "token-1",
      provider: "echo",
      scopes: ["POST:/v1/"],
      label: "smoke",
      ttlSeconds: 600,
    });
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    const verified = await verifyToken(SECRET, raw);
    expect("error" in verified).toBe(false);
    if ("error" in verified) throw new Error("unreachable");
    expect(verified.tokenId).toBe("token-1");
    expect(verified.claims.prv).toBe("echo");
    expect(verified.claims.scp).toEqual(["POST:/v1/"]);
    expect(verified.claims.lbl).toBe("smoke");
  });

  it("fails verify with bad signature (different secret)", async () => {
    const raw = await issueToken(SECRET, {
      tokenId: "token-2",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 60,
    });
    const otherSecret = generateJwtSecret();
    const result = await verifyToken(otherSecret, raw);
    expect("error" in result).toBe(true);
  });

  it("fails verify when prefix is missing", async () => {
    const raw = await issueToken(SECRET, {
      tokenId: "token-3",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 60,
    });
    const stripped = raw.slice(TOKEN_PREFIX.length);
    const result = await verifyToken(SECRET, stripped);
    expect(result).toEqual({ error: "missing_prefix" });
  });

  it("fails verify on tampered payload", async () => {
    const raw = await issueToken(SECRET, {
      tokenId: "token-4",
      provider: "echo",
      scopes: ["POST:/v1/"],
      label: "x",
      ttlSeconds: 60,
    });
    // Flip one char in the JWT payload section.
    const idx = raw.length - 10;
    const ch = raw.charAt(idx);
    const swap = ch === "A" ? "B" : "A";
    const tampered = raw.slice(0, idx) + swap + raw.slice(idx + 1);
    const result = await verifyToken(SECRET, tampered);
    expect("error" in result).toBe(true);
  });

  it("fails verify when expired", async () => {
    // ttl = 1 second; sleep > 1s, then verify.
    const raw = await issueToken(SECRET, {
      tokenId: "token-5",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const result = await verifyToken(SECRET, raw);
    expect("error" in result).toBe(true);
  });

  it("ttl=0 issues a non-expiring token", async () => {
    const raw = await issueToken(SECRET, {
      tokenId: "token-6",
      provider: "echo",
      scopes: ["*"],
      label: "x",
      ttlSeconds: 0,
    });
    const result = await verifyToken(SECRET, raw);
    expect("error" in result).toBe(false);
  });
});
