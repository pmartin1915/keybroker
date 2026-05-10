import { describe, it, expect } from "vitest";
import { matchesGlob, matchesAny } from "../src/glob-match.js";

describe("matchesGlob", () => {
  it("matches an exact pattern with no wildcard", () => {
    expect(matchesGlob("gpt-4o-mini", "gpt-4o-mini")).toBe(true);
    expect(matchesGlob("gpt-4o", "gpt-4o-mini")).toBe(false);
    expect(matchesGlob("gpt-4o-mini-extra", "gpt-4o-mini")).toBe(false);
  });

  it("treats `*` alone as match-all", () => {
    expect(matchesGlob("anything", "*")).toBe(true);
    expect(matchesGlob("", "*")).toBe(true);
  });

  it("matches a prefix wildcard `*-preview`", () => {
    expect(matchesGlob("gemini-3-pro-preview", "*-preview")).toBe(true);
    expect(matchesGlob("o1-preview", "*-preview")).toBe(true);
    expect(matchesGlob("gemini-3-pro", "*-preview")).toBe(false);
    expect(matchesGlob("preview", "*-preview")).toBe(false); // requires the "-" prefix
  });

  it("matches a suffix wildcard `gpt-4o-mini*`", () => {
    expect(matchesGlob("gpt-4o-mini", "gpt-4o-mini*")).toBe(true);
    expect(matchesGlob("gpt-4o-mini-2024-07-18", "gpt-4o-mini*")).toBe(true);
    expect(matchesGlob("gpt-4o", "gpt-4o-mini*")).toBe(false);
    expect(matchesGlob("gpt-4-turbo", "gpt-4o-mini*")).toBe(false);
  });

  it("matches a middle wildcard `*claude*`", () => {
    expect(matchesGlob("claude-3-opus", "*claude*")).toBe(true);
    expect(matchesGlob("anthropic-claude-3", "*claude*")).toBe(true);
    expect(matchesGlob("gpt-4o", "*claude*")).toBe(false);
  });

  it("treats regex metacharacters as literal in patterns", () => {
    // `.` is literal — pattern "1.0" matches only "1.0", not "1x0"
    expect(matchesGlob("1.0", "1.0")).toBe(true);
    expect(matchesGlob("1x0", "1.0")).toBe(false);
    // `+` is literal — pattern "a+" matches only "a+"
    expect(matchesGlob("a+", "a+")).toBe(true);
    expect(matchesGlob("aaa", "a+")).toBe(false);
    // `?`, `(`, `)`, `[`, `]`, `^`, `$`, `\` similarly
    expect(matchesGlob("(x)", "(x)")).toBe(true);
    expect(matchesGlob("x", "(x)")).toBe(false);
  });

  it("compound globs combine prefix and suffix", () => {
    expect(matchesGlob("gpt-4o-mini-preview", "gpt-*-preview")).toBe(true);
    expect(matchesGlob("gpt-4o-mini", "gpt-*-preview")).toBe(false);
  });

  it("handles back-to-back wildcards as a single match-anything", () => {
    expect(matchesGlob("anything", "**")).toBe(true);
    expect(matchesGlob("preview", "*-*")).toBe(false); // needs a literal "-"
    expect(matchesGlob("a-b", "*-*")).toBe(true);
  });
});

describe("matchesAny", () => {
  it("returns false on empty pattern list (no rules → no match)", () => {
    expect(matchesAny("anything", [])).toBe(false);
  });

  it("returns true if any pattern matches", () => {
    expect(matchesAny("gemini-3-pro-preview", ["gpt-*", "*-preview"])).toBe(true);
  });

  it("returns false if no pattern matches", () => {
    expect(matchesAny("gpt-4o-mini", ["gemini-*", "claude-*"])).toBe(false);
  });
});
