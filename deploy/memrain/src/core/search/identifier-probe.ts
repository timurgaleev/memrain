/** Distinct identifiers that can survive a question's unrelated prose words. */
export function identifierTokens(query: string): string[] {
  const tokens = new Set<string>();
  const pattern = /https?:\/\/[^\s<>"`]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}|#[0-9]+|[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu;
  for (const match of query.matchAll(pattern)) {
    const token = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (token.length > 256) continue;
    if (/^\d+$/.test(token) && query[match.index - 1] === "+") continue;
    if (/^https?:\/\//i.test(token) || token.includes("@") || /^#\d+$/.test(token)
      || /^\d{6,}$/.test(token) || /^[a-f\d]{7,}$/i.test(token)
      || /^v?\d+(?:\.\d+){2,}(?:[-+][a-z\d.-]+)?$/i.test(token)
      || (/\p{L}/u.test(token) && /\d/.test(token))) tokens.add(token);
  }
  return [...tokens];
}
