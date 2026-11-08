const MAX_PROBE_QUERY_CHARS = 8192;
const MAX_PROBE_IDENTIFIERS = 16;
const MAX_IDENTIFIER_CHARS = 256;

/** Scan once; oversized probes must not turn an all-identifiers AND into a subset. */
export function scanIdentifierProbe(query: string): { tokens: string[]; hasProse: boolean; incomplete: boolean } {
  const declined = { tokens: [], hasProse: false, incomplete: true };
  if (query.length > MAX_PROBE_QUERY_CHARS) return declined;
  const tokens = new Set<string>();
  let hasProse = false;
  // Consume runs before classifying: an email-shaped alternative at each '%'
  // position would backtrack quadratically on punctuation-only input.
  const pattern = /https?:\/\/[^\s<>"`]+|[#\p{L}\p{N}._%+@/-]+/gu;
  for (const match of query.matchAll(pattern)) {
    const token = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (token.length > MAX_IDENTIFIER_CHARS) return declined;
    const identifier = /^https?:\/\//i.test(token)
      || /^[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}$/u.test(token)
      || /^#\d+$/.test(token) || /^\d{6,}$/.test(token) || /^[a-f\d]{7,}$/i.test(token)
      || /^v?\d+(?:\.\d+){2,}(?:[-+][a-z\d.-]+)?$/i.test(token)
      || (/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(token) && /\p{L}/u.test(token) && /\d/.test(token));
    if (identifier) {
      tokens.add(token);
      if (tokens.size > MAX_PROBE_IDENTIFIERS) return declined;
    } else if (/[\p{L}\p{N}]/u.test(token)) hasProse = true;
  }
  return { tokens: [...tokens], hasProse, incomplete: false };
}

/** Distinct identifiers that can survive a question's unrelated prose words. */
export function identifierTokens(query: string): string[] {
  return scanIdentifierProbe(query).tokens;
}
