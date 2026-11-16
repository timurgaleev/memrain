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
  = "\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F"
    + "\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u0098\u2122\u0459\u203A\u045A\u045C\u045B\u045F"
    + "\u00A0\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407"
    + "\u00B0\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457"
    + "\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041A\u041B\u041C\u041D\u041E\u041F"
    + "\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042A\u042B\u042C\u042D\u042E\u042F"
    + "\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043A\u043B\u043C\u043D\u043E\u043F"
    + "\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044A\u044B\u044C\u044D\u044E\u044F";

const KOI8_R
  = "\u2500\u2502\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2580\u2584\u2588\u258C\u2590"
    + "\u2591\u2592\u2593\u2320\u25A0\u2219\u221A\u2248\u2264\u2265\u00A0\u2321\u00B0\u00B2\u00B7\u00F7"
    + "\u2550\u2551\u2552\u0451\u2553\u2554\u2555\u2556\u2557\u2558\u2559\u255A\u255B\u255C\u255D\u255E"
    + "\u255F\u2560\u2561\u0401\u2562\u2563\u2564\u2565\u2566\u2567\u2568\u2569\u256A\u256B\u256C\u00A9"
    + "\u044E\u0430\u0431\u0446\u0434\u0435\u0444\u0433\u0445\u0438\u0439\u043A\u043B\u043C\u043D\u043E"
    + "\u043F\u044F\u0440\u0441\u0442\u0443\u0436\u0432\u044C\u044B\u0437\u0448\u044D\u0449\u0447\u044A"
    + "\u042E\u0410\u0411\u0426\u0414\u0415\u0424\u0413\u0425\u0418\u0419\u041A\u041B\u041C\u041D\u041E"
    + "\u041F\u042F\u0420\u0421\u0422\u0423\u0416\u0412\u042C\u042B\u0417\u0428\u042D\u0429\u0427\u042A";

/** ISO-8859-15 is Latin-1 with eight code points replaced. */
const ISO_8859_15 = (() => {
  const swaps: Record<number, string> = { 0xA4: "\u20AC", 0xA6: "\u0160", 0xA8: "\u0161", 0xB4: "\u017D", 0xB8: "\u017E", 0xBC: "\u0152", 0xBD: "\u0153", 0xBE: "\u0178" };
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
