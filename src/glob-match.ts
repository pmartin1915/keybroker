/**
 * Tiny glob matcher. Only `*` is special — it matches any sequence of
 * characters, including the empty string. Every other character is literal,
 * including `.`, `?`, brackets, etc.
 *
 * Used by Phase 2.1 (per-token `mdl` allow-list) and Phase 2.4
 * (`forbidden_models` deny-list). The patterns we accept here are operator-
 * authored, not user-supplied — so this does not need to defend against
 * regex DoS. The compiled-pattern cache is bounded only by the number of
 * distinct patterns the operator writes, which is tiny.
 */

const cache = new Map<string, RegExp>();

const REGEX_META = /[.+?^${}()|[\]\\]/g;

function compile(pattern: string): RegExp {
  let body = "";
  for (const ch of pattern) {
    body += ch === "*" ? ".*" : ch.replace(REGEX_META, "\\$&");
  }
  return new RegExp("^" + body + "$");
}

export function matchesGlob(value: string, pattern: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = compile(pattern);
    cache.set(pattern, re);
  }
  return re.test(value);
}

export function matchesAny(value: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (matchesGlob(value, p)) return true;
  }
  return false;
}
