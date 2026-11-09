import { randomBytes } from "node:crypto";

/** One decoding layer, with offsets into the original text for every emitted character. */
export interface EncodedCandidate {
  value: string;
  starts: number[];
  ends: number[];
  base64?: { start: number; end: number };
  bounds?: { start: number; end: number };
}

const MAX_CANDIDATE = 8192;
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;
const ENCODED = /\\u[\dA-Fa-f]{4}|%2[fF]|%3[aA]|[\u200B-\u200D\u2060\uFEFF]/;

function decodeLine(raw: string, offset: number): EncodedCandidate {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < raw.length;) {
    const start = i;
    let char = raw[i]!;
    i++;
    if (char === "\\" && raw[i] === "\\") {
      chars.push(char, char); starts.push(offset + start, offset + i); ends.push(offset + i, offset + i + 1);
      i++;
      continue;
    }
    if (char === "\\" && raw[i] === "u" && /^\\u[\dA-Fa-f]{4}$/.test(raw.slice(start, start + 6))) {
      const code = Number.parseInt(raw.slice(start + 2, start + 6), 16);
      const decoded = String.fromCharCode(code);
      if ((code >= 0x20 && code <= 0x7E) || ZERO_WIDTH.test(decoded)) { char = decoded; i = start + 6; }
    } else if (char === "%" && /^%(?:2f|3a)$/i.test(raw.slice(start, start + 3))) {
      char = String.fromCharCode(Number.parseInt(raw.slice(start + 1, start + 3), 16));
      i = start + 3;
    }
    if (char >= "\u200B" && ZERO_WIDTH.test(char)) continue;
    chars.push(char); starts.push(offset + start); ends.push(offset + i);
  }
  return { value: chars.join(""), starts, ends };
}

export function* encodedCandidates(text: string, assignments: readonly RegExp[]): Generator<EncodedCandidate> {
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    if (!ENCODED.test(line[0])) continue;
    if (line[0].length <= MAX_CANDIDATE) {
      yield decodeLine(line[0], line.index);
      continue;
    }
    // A large JSON record or prose paragraph still has bounded credential
    // values. Keep context for assignment/start guards, but never claim it.
    for (const token of line[0].matchAll(/[^\t\v\f\r\n "'{}[\],;]+/g)) {
      if (token[0].length > 4096 || !ENCODED.test(token[0])) continue;
      const start = line.index + token.index;
      const end = start + token[0].length;
      const contextStart = Math.max(line.index, start - 128);
      const contextEnd = Math.min(line.index + line[0].length, end + 128);
      yield { ...decodeLine(text.slice(contextStart, contextEnd), contextStart), bounds: { start, end } };
    }
  }
  // Only explicitly named credential values are decoded as base64. Matching
  // a complete vendor shape afterwards distinguishes a key from ordinary data.
  for (const pattern of assignments) {
    for (const match of text.matchAll(pattern)) {
      const encoded = match[2]!;
      if (encoded.length > 4096 || !/^[\w+/-]{16,4096}={0,2}$/.test(encoded)) continue;
      const bytes = Buffer.from(encoded, "base64");
      const canonical = encoded.replaceAll("-", "+").replaceAll("_", "/").replace(/={1,2}$/, "");
      if (bytes.toString("base64").replace(/={1,2}$/, "") !== canonical) continue;
      if (bytes.length < 16 || bytes.some(b => b < 0x21 || b > 0x7E)) continue;
      const value = bytes.toString("utf8");
      const start = match.index + match[1]!.length;
      yield { value, starts: [], ends: [], base64: { start, end: start + encoded.length } };
    }
  }
}
/** Shield an allowed encoded span from partial matches by the plain-text rules. */
export function protectEncodedAllowlist(text: string): { keep: (raw: string) => string; restore: (value: string) => string } {
  const preserved = new Map<string, string>();
  let prefix = "";
  return {
    keep: (raw) => {
      if (!prefix) {
        do { prefix = `[REDACTED:allowed-${randomBytes(8).toString("hex")}:`; } while (text.includes(prefix));
      }
      const marker = `${prefix}${preserved.size.toString(16).padStart(16, "0")}]`;
      preserved.set(marker, raw);
      return marker;
    },
    restore: (value) => preserved.size === 0 ? value : value.replace(
      /\[REDACTED:allowed-[a-f\d]{16}:[a-f\d]{16}\]/g, marker => preserved.get(marker) ?? marker,
    ),
  };
}
