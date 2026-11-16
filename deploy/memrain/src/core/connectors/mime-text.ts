/**
 * Mail text as its sender wrote it: bytes decoded with the charset a MIME
 * part declares, and RFC 2047 encoded words (`=?charset?B|Q?text?=`) in
 * header text. Pure, linear, and never throws on hostile input: an unknown
 * charset reads as UTF-8 with replacement characters, and a malformed encoded
 * word stays as written.
 *
 * TextDecoder covers most labels. A runtime may lack some single-byte
 * charsets; the ones common in German and Russian mail are tabled here and
 * used only when TextDecoder refuses their label.
 */

/** Bytes 0x80..0xFF of the tabled single-byte charsets. */
const WINDOWS_1251
  = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ"
    + "ђ‘’“”•–—\u0098™љ›њќћџ"
    + " ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї"
    + "°±Ііґµ¶·ё№є»јЅѕї"
    + "АБВГДЕЖЗИЙКЛМНОП"
    + "РСТУФХЦЧШЩЪЫЬЭЮЯ"
    + "абвгдежзийклмноп"
    + "рстуфхцчшщъыьэюя";

const KOI8_R
  = "─│┌┐└┘├┤┬┴┼▀▄█▌▐"
    + "░▒▓⌠■∙√≈≤≥ ⌡°²·÷"
    + "═║╒ё╓╔╕╖╗╘╙╚╛╜╝╞"
    + "╟╠╡Ё╢╣╤╥╦╧╨╩╪╫╬©"
    + "юабцдефгхийклмно"
    + "пярстужвьызшэщчъ"
    + "ЮАБЦДЕФГХИЙКЛМНО"
    + "ПЯРСТУЖВЬЫЗШЭЩЧЪ";

/** ISO-8859-15 is Latin-1 with eight code points replaced. */
const ISO_8859_15 = (() => {
  const swaps: Record<number, string> = { 0xA4: "€", 0xA6: "Š", 0xA8: "š", 0xB4: "Ž", 0xB8: "ž", 0xBC: "Œ", 0xBD: "œ", 0xBE: "Ÿ" };
  let out = "";
  for (let b = 0x80; b <= 0xFF; b++) out += swaps[b] ?? String.fromCharCode(b);
  return out;
})();

/** The WHATWG labels of each tabled charset. */
const TABLES: ReadonlyArray<{ labels: readonly string[]; high: string }> = [
  { labels: ["windows-1251", "cp1251", "x-cp1251"], high: WINDOWS_1251 },
  { labels: ["koi8-r", "koi8_r", "koi8", "koi", "cskoi8r"], high: KOI8_R },
  { labels: ["iso-8859-15", "iso8859-15", "iso885915", "iso_8859-15", "csisolatin9", "l9", "latin9", "latin-9"], high: ISO_8859_15 },
];

const UTF8 = new TextDecoder("utf-8");
const LABEL_RE = /^[\w.:+-]{1,40}$/;

function singleByte(bytes: Uint8Array, high: string): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : high[b - 0x80]!;
  return out;
}

/** `bytes` read in `charset` (a MIME label, any case, quotes allowed); UTF-8 when absent or unknown. */
export function decodeCharset(bytes: Uint8Array, charset: string | null): string {
  const label = (charset ?? "").trim().replace(/^"(.*)"$/s, "$1").trim().toLowerCase();
  if (label === "" || !LABEL_RE.test(label)) return UTF8.decode(bytes);
  try {
    // Any label the runtime knows; the type lists only a few.
    return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    const table = TABLES.find(t => t.labels.includes(label));
    return table ? singleByte(bytes, table.high) : UTF8.decode(bytes);
  }
}

/** The `charset` parameter of a Content-Type value, or null. */
export function contentTypeCharset(contentType: string): string | null {
  const m = /;\s*charset\s*=\s*("[^"]{0,64}"|[^\s;]{1,64})/i.exec(contentType);
  return m ? m[1]!.replace(/^"(.*)"$/s, "$1") : null;
}

const B64_RE = /^[A-Z0-9+/]*={0,2}$/i;
const ENCODED_WORD = /=\?([^?\s*]{1,64})(?:\*[^?\s]{0,32})?\?([BQ])\?([^?\s]*)\?=/gi;

/** The bytes of one encoded word's text, or null when it is malformed. */
function wordBytes(encoding: string, text: string): Buffer | null {
  if (encoding === "B" || encoding === "b") {
    if (!B64_RE.test(text) || text.length % 4 === 1) return null;
    return Buffer.from(text, "base64");
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") out.push(0x20);
    else if (c === "=") {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/i.test(hex)) return null;
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      const code = c.charCodeAt(0);
      if (code > 0x7E) return null;
      out.push(code);
    }
  }
  return Buffer.from(out);
}

/**
 * Header text with its RFC 2047 encoded words decoded. Whitespace between two
 * adjacent encoded words is dropped (section 6.2). Consecutive words in one
 * charset are decoded together, so a character a sender split across two
 * words survives. A malformed word stays as written.
 */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  let out = "";
  let last = 0;
  // The run of adjacent words in one charset not yet decoded.
  let runCharset: string | null = null;
  let runBytes: Buffer[] = [];
  const flush = () => {
    if (runCharset !== null) out += decodeCharset(Buffer.concat(runBytes), runCharset);
    runCharset = null;
    runBytes = [];
  };
  for (const m of value.matchAll(ENCODED_WORD)) {
    const bytes = wordBytes(m[2]!, m[3]!);
    if (bytes === null) continue;
    const gap = value.slice(last, m.index);
    const charset = m[1]!.toLowerCase();
    if (runCharset === null || !/^[ \t\r\n]*$/.test(gap)) {
      flush();
      out += gap;
    } else if (runCharset !== charset) {
      flush();
    }
    runCharset = charset;
    runBytes.push(bytes);
    last = m.index + m[0].length;
  }
  flush();
  return out + value.slice(last);
}
