/**
 * Phase 4.2a — Layer 1.5 decoders.
 *
 * Pure, deterministic, stateless functions that produce a *decoded view* of a
 * request-body buffer. Each decoder returns a Buffer (possibly empty) or null
 * when nothing decodable was found. The scanner applies each decoder in
 * declared order and runs the existing Phase 3.6 BUILTIN_DETECTORS against
 * every non-empty view.
 *
 * Design constraints (all load-bearing — see decision_phase_4_2_a_decoding.md):
 *   - Max ONE layer of decoding per view. No recursive re-decode.
 *   - Fail-open on decode error: skip the view, continue scanning others.
 *   - No new npm dependencies. Node built-ins only.
 *   - No I/O, no async, no shared state across requests.
 *   - Never log or expose the matched (decoded) substring — the caller only
 *     surfaces the detector name.
 *   - Decoder contract: (buf: Buffer) => Buffer | null
 */

/**
 * DECODER 1 — base64 (standard + URL-safe alphabets).
 *
 * Extracts candidate runs of base64-charset characters of length >= 16 (to
 * cover AKIA… 20-char keys when encoded, while excluding noise like short
 * identifiers or common words). Both standard [A-Za-z0-9+/=] and URL-safe
 * [A-Za-z0-9_-] alphabets are handled by Node's Buffer.from(…, 'base64'),
 * which accepts both transparently. If a candidate decodes to valid UTF-8
 * with a reasonable proportion of printable ASCII characters, its decoded
 * text is appended to the output view. Non-printable garbage (binary blobs)
 * is silently skipped to avoid false-positive hits on embedded binary data.
 *
 * Note: URL-safe base64 lacks the `=` padding character, but Node handles
 * this gracefully with lenient decoding.
 */
export function decodeBase64(buf: Buffer): Buffer | null {
  if (!buf || buf.byteLength === 0) return null;

  const text = buf.toString("utf8");

  // Match runs of base64-charset chars (both standard and URL-safe) with
  // minimum length 16. The alternation handles padding chars for standard
  // base64. A minimum of 16 chars means at least 12 decoded bytes — enough
  // to contain a real secret but unlikely to trigger on UUIDs or identifiers
  // embedded in prose text.
  const BASE64_RE = /[A-Za-z0-9+/=_-]{16,}/g;

  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = BASE64_RE.exec(text)) !== null) {
    const candidate = m[0];
    try {
      const decoded = Buffer.from(candidate, "base64");
      // Skip empty or trivially short results (< 8 decoded bytes)
      if (decoded.byteLength < 8) continue;
      // Validate: decoded bytes should be valid UTF-8 and mostly printable.
      // We round-trip through toString("utf8") and back; if byte count
      // differs significantly from the original decode, there are replacement
      // chars indicating binary garbage — skip.
      const asUtf8 = decoded.toString("utf8");
      const reEncoded = Buffer.from(asUtf8, "utf8");
      if (reEncoded.byteLength !== decoded.byteLength) continue;
      // Require >= 50% printable ASCII (code points 0x20–0x7E plus tab/LF/CR).
      // This blocks decoded blobs that happen to be valid UTF-8 sequences but
      // are clearly binary (e.g. random noise, compressed content).
      let printable = 0;
      for (let i = 0; i < decoded.byteLength; i++) {
        const b = decoded[i];
        if (
          (b !== undefined) &&
          ((b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d)
        ) {
          printable++;
        }
      }
      if (printable / decoded.byteLength < 0.5) continue;
      parts.push(asUtf8);
    } catch {
      // Decode error — skip candidate (fail-open, invariant 5)
    }
  }

  if (parts.length === 0) return null;
  return Buffer.from(parts.join(" "), "utf8");
}

/**
 * DECODER 2 — URL-encoding.
 *
 * Runs decodeURIComponent on the full body text. Percent-encoded sequences
 * like %41%4B%49%41 are decoded to their character equivalents. If the body
 * is not percent-encoded (no % sequences), the result is identical to the
 * input — which is fine since the same detectors will just run again and
 * either hit or not. Returns null only on decode error or empty buffer.
 *
 * Fail-open: if decodeURIComponent throws (malformed escape like %ZZ), this
 * view is skipped (returns null) and the raw scan path is unaffected.
 */
export function decodeUrlEncoded(buf: Buffer): Buffer | null {
  if (!buf || buf.byteLength === 0) return null;

  const text = buf.toString("utf8");
  // Only bother decoding if there are percent-encoded sequences
  if (!text.includes("%")) return null;

  try {
    const decoded = decodeURIComponent(text);
    // If the decoded string is identical to the input, nothing was encoded
    if (decoded === text) return null;
    return Buffer.from(decoded, "utf8");
  } catch {
    // Malformed percent-encoding — fail-open (invariant 5), skip this view
    return null;
  }
}

/**
 * DECODER 3 — JSON string unescape.
 *
 * Finds plausible JSON-quoted string tokens in the body and unescapes them
 * (resolving \n, \t, \", \\, \uXXXX, etc.). Uses JSON.parse to correctly
 * handle all escape sequences. Concatenates successful unescapes into a
 * single view. Failures are skipped (fail-open).
 *
 * Target: bodies like `{"key":"sk_live_\\\"ABCDEF\\\""}`  or  wrapped
 * string values where the key itself contains JSON escape sequences.
 *
 * Extraction strategy: regex out content inside double-quote pairs that
 * contains at least one backslash escape, then JSON.parse the quoted chunk.
 * We wrap the inner content in quotes before parsing so we don't require the
 * rest of the JSON to be well-formed.
 */
export function decodeJsonStringUnescape(buf: Buffer): Buffer | null {
  if (!buf || buf.byteLength === 0) return null;

  const text = buf.toString("utf8");
  // Only bother if there are backslash-escape sequences inside quoted strings
  if (!text.includes("\\")) return null;

  // Match JSON string literals: opening ", then content with at least one
  // backslash (meaning there is something to unescape), then closing ".
  // We use a non-greedy match and exclude unescaped double-quotes inside
  // (they would signal a malformed literal). The pattern captures the content
  // between the outer quotes.
  //
  // Pattern breakdown:
  //   "          — opening double-quote
  //   (          — capture group for inner content
  //     (?:      — non-capturing alternation for each char:
  //       \\.    —   any backslash-escaped char (the escape sequence)
  //       |      —   OR
  //       [^"\\] —   any char that is not quote or backslash
  //     )*       — zero or more such chars
  //   )
  //   "          — closing double-quote
  //
  // We only take candidates that contain at least one backslash so we don't
  // re-scan plain unescaped string values (the raw scan already covered them).
  const JSON_STRING_RE = /"((?:\\.|[^"\\])*)"/g;

  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = JSON_STRING_RE.exec(text)) !== null) {
    const inner = m[1];
    // Skip strings with no backslash (nothing to unescape)
    if (inner === undefined || !inner.includes("\\")) continue;
    try {
      // JSON.parse on a standalone quoted string correctly handles all
      // JSON escape sequences: \n \t \" \\ \/ \b \f \uXXXX
      const unescaped: unknown = JSON.parse(`"${inner}"`);
      if (typeof unescaped === "string" && unescaped.length > 0) {
        parts.push(unescaped);
      }
    } catch {
      // Malformed JSON escape — skip (fail-open, invariant 5)
    }
  }

  if (parts.length === 0) return null;
  return Buffer.from(parts.join(" "), "utf8");
}

/**
 * The three decoders in declared order (matters for first-hit-wins semantics
 * in scanBytes). Exported so tests can iterate over them without coupling to
 * their names.
 */
export const DECODERS: ReadonlyArray<{
  readonly name: string;
  readonly fn: (buf: Buffer) => Buffer | null;
}> = [
  { name: "base64", fn: decodeBase64 },
  { name: "urlencode", fn: decodeUrlEncoded },
  { name: "json_string_unescape", fn: decodeJsonStringUnescape },
];
