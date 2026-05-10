import { describe, it, expect } from "vitest";
import { normalizeMachine } from "../src/hostname.js";

describe("normalizeMachine (Phase 3.0)", () => {
  it("lowercases mixed-case input", () => {
    expect(normalizeMachine("PERRY-PC")).toBe("perry-pc");
    expect(normalizeMachine("MyHost.example.COM")).toBe("myhost.example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeMachine("  perry-pc  ")).toBe("perry-pc");
    expect(normalizeMachine("\tperry-pc\n")).toBe("perry-pc");
  });

  it("returns undefined for undefined input (passthrough)", () => {
    expect(normalizeMachine(undefined)).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only input", () => {
    expect(normalizeMachine("")).toBeUndefined();
    expect(normalizeMachine("   ")).toBeUndefined();
    expect(normalizeMachine("\t\n")).toBeUndefined();
  });

  it("preserves trailing dots and FQDN suffixes verbatim", () => {
    // We deliberately do NOT strip trailing dots or FQDN suffixes —
    // both sides of the broker/dispatcher boundary must apply the SAME
    // function or they will drift, and conservative is safer than clever.
    expect(normalizeMachine("host.local.")).toBe("host.local.");
    expect(normalizeMachine("HOST.example.com")).toBe("host.example.com");
  });

  it("is idempotent", () => {
    const once = normalizeMachine("PERRY-PC");
    const twice = normalizeMachine(once);
    expect(twice).toBe(once);
  });
});
