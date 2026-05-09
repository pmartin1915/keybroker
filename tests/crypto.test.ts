import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  encrypt,
  decrypt,
  generateMasterKeyHex,
  generateJwtSecret,
} from "../src/crypto.js";

const KEY = generateMasterKeyHex();

describe("crypto: round-trip", () => {
  it("decrypts what it encrypted", () => {
    const pt = "sk-fake-upstream-key-1234567890";
    const ct = encrypt(pt, KEY);
    expect(decrypt(ct, KEY)).toBe(pt);
  });

  it("survives unicode and empty plaintext", () => {
    expect(decrypt(encrypt("", KEY), KEY)).toBe("");
    expect(decrypt(encrypt("héllo 🔐 wörld", KEY), KEY)).toBe("héllo 🔐 wörld");
  });

  it("produces a different ciphertext for the same plaintext (random IV)", () => {
    const pt = "same-plaintext";
    const a = encrypt(pt, KEY);
    const b = encrypt(pt, KEY);
    expect(a).not.toBe(b);
  });
});

describe("crypto: tampering must throw", () => {
  function flipByte(b64: string, offset: number): string {
    const buf = Buffer.from(b64, "base64");
    if (offset >= buf.length) throw new Error("offset OOB");
    buf[offset] = (buf[offset] ?? 0) ^ 0xff;
    return buf.toString("base64");
  }

  const pt = "secret-payload";

  it("flipped bit in IV throws", () => {
    const ct = encrypt(pt, KEY);
    expect(() => decrypt(flipByte(ct, 0), KEY)).toThrow();
  });

  it("flipped bit in tag throws", () => {
    const ct = encrypt(pt, KEY);
    expect(() => decrypt(flipByte(ct, 12), KEY)).toThrow();
  });

  it("flipped bit in ciphertext throws", () => {
    const ct = encrypt(pt, KEY);
    const buf = Buffer.from(ct, "base64");
    expect(buf.length).toBeGreaterThan(28);
    expect(() => decrypt(flipByte(ct, 28), KEY)).toThrow();
  });

  it("ciphertext shorter than IV+tag throws", () => {
    expect(() => decrypt(Buffer.alloc(10).toString("base64"), KEY)).toThrow(
      /too short/,
    );
  });

  it("decrypt with a different key throws", () => {
    const ct = encrypt(pt, KEY);
    const otherKey = generateMasterKeyHex();
    expect(() => decrypt(ct, otherKey)).toThrow();
  });
});

describe("crypto: key length validation", () => {
  it("encrypt rejects wrong-length key", () => {
    expect(() => encrypt("x", "deadbeef")).toThrow(/32 bytes/);
    // 31 bytes (62 hex chars)
    const short = "a".repeat(62);
    expect(() => encrypt("x", short)).toThrow(/32 bytes/);
    // 33 bytes (66 hex chars) — Buffer.from is lenient about extra hex
    // chars, but 33 bytes still fails the length check.
    const long = "a".repeat(66);
    expect(() => encrypt("x", long)).toThrow(/32 bytes/);
  });
});

describe("crypto: key generators", () => {
  it("generateMasterKeyHex returns 64 hex chars (32 bytes)", () => {
    const k = generateMasterKeyHex();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(k, "hex").length).toBe(32);
  });

  it("generateJwtSecret returns base64url with at least 32 bytes of entropy", () => {
    const s = generateJwtSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes -> 43 base64url chars (no padding).
    expect(s.length).toBe(43);
  });

  it("master keys are not equal across calls", () => {
    expect(generateMasterKeyHex()).not.toBe(generateMasterKeyHex());
  });
});
