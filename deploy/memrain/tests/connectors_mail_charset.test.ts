/**
 * Mail text in the charset it declares: a body part's bytes are decoded with
 * its Content-Type charset (an unknown label falls back to UTF-8 with
 * replacement characters, never an exception), and RFC 2047 encoded words in
 * Subject and in address display names are decoded, B and Q, across adjacent
 * words and mixed charsets. A malformed encoded word is left as written.
 * Non-ASCII expectations are written as escapes, so the source stays ASCII.
 */
import { describe, expect, it } from "bun:test";
import { extractBody, parseAddressList, type GmailMimePart } from "../src/core/connectors/google/gmail-mime.ts";
import { normalizeGmailMessage } from "../src/core/connectors/google/gmail.ts";
import { decodeCharset, decodeEncodedWords } from "../src/core/connectors/mime-text.ts";

/** "Privet, mir" in Russian. */
const RU = "Привет, мир";
/** "Gruesse aus Muenchen" with its umlauts. */
const DE = "Grüße aus München";
const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const ru1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x2c, 0x20, 0xec, 0xe8, 0xf0]);
const ruKoi8 = Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4, 0x2c, 0x20, 0xcd, 0xc9, 0xd2]);
const deLatin1 = Buffer.from(DE, "latin1");

function textPart(bytes: Buffer, contentType: string, mimeType = "text/plain"): GmailMimePart {
  return { mimeType, headers: [{ name: "Content-Type", value: contentType }], body: { data: b64url(bytes) } };
}

describe("body charset", () => {
  it("decodes a windows-1251 Russian body and a koi8-r one", () => {
    expect(extractBody(textPart(ru1251, "text/plain; charset=windows-1251")).text).toBe(RU);
    expect(extractBody(textPart(ruKoi8, "text/plain; charset=\"KOI8-R\"")).text).toBe(RU);
  });

  it("decodes an iso-8859-1 German body with umlauts, and iso-8859-15's euro sign", () => {
    expect(extractBody(textPart(deLatin1, "text/plain; charset=ISO-8859-1")).text).toBe(DE);
    expect(extractBody(textPart(Buffer.from([0x31, 0x30, 0x20, 0xa4]), "text/plain; format=flowed; charset=iso-8859-15")).text).toBe("10 €");
  });

  it("decodes each part with its own charset, html included", () => {
    const root: GmailMimePart = {
      mimeType: "multipart/mixed",
      parts: [textPart(ru1251, "text/plain; charset=cp1251"), textPart(Buffer.from(`<p>${DE}</p>`, "latin1"), "text/html; charset=latin1", "text/html")],
    };
    const body = extractBody(root).text;
    expect(body).toContain(RU);
    expect(body).toContain(DE);
  });

  it("decodes utf-16 with its byte order mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(RU, "utf16le")]);
    expect(extractBody(textPart(bytes, "text/plain; charset=utf-16")).text).toBe(RU);
  });

  it("reads UTF-8 when the charset is missing or unknown, with replacement characters and no exception", () => {
    expect(extractBody({ mimeType: "text/plain", body: { data: b64url(Buffer.from(RU)) } }).text).toBe(RU);
    expect(extractBody(textPart(Buffer.from(RU), "text/plain; charset=x-no-such-charset")).text).toBe(RU);
    expect(decodeCharset(new Uint8Array([0x41, 0xff, 0x42]), "x-no-such-charset")).toBe("A�B");
    expect(decodeCharset(new Uint8Array([0x41]), "\"\u0000bad label\"")).toBe("A");
  });
});

describe("RFC 2047 encoded words", () => {
  it("decodes B and Q words in a subject", () => {
    expect(decodeEncodedWords(`=?UTF-8?B?${Buffer.from(RU).toString("base64")}?=`)).toBe(RU);
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Gr=FC=DFe_aus_M=FCnchen?=")).toBe(DE);
    expect(decodeEncodedWords("=?iso-8859-1?q?Gr=fc=dfe?= aus Berlin")).toBe("Grüße aus Berlin");
  });

  it("drops whitespace between adjacent words only, and joins a character split across them", () => {
    const bytes = Buffer.from(RU);
    // Split inside a two-byte character: each half alone is invalid UTF-8.
    const a = bytes.subarray(0, 3).toString("base64");
    const b = bytes.subarray(3).toString("base64");
    expect(decodeEncodedWords(`=?UTF-8?B?${a}?=\r\n =?UTF-8?B?${b}?=`)).toBe(RU);
    expect(decodeEncodedWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?=")).toBe("ab");
    expect(decodeEncodedWords("=?UTF-8?Q?a?= plain =?UTF-8?Q?b?=")).toBe("a plain b");
    expect(decodeEncodedWords("Re: =?UTF-8?Q?a?=")).toBe("Re: a");
  });

  it("decodes adjacent words in different charsets", () => {
    const ru = `=?windows-1251?B?${ru1251.toString("base64")}?=`;
    expect(decodeEncodedWords(`=?ISO-8859-1?Q?Gr=FC=DFe?= ${ru}`)).toBe(`Grüße${RU}`);
  });

  it("leaves a malformed encoded word as written", () => {
    for (const bad of ["=?UTF-8?B?not base64!?=", "=?UTF-8?Q?=ZZbad?=", "=?UTF-8?X?abc?=", "=?UTF-8?B?abc", "=??B?abc?="]) {
      expect(decodeEncodedWords(bad)).toBe(bad);
    }
    expect(decodeEncodedWords("plain subject, no words")).toBe("plain subject, no words");
  });

  it("decodes an unknown charset's word as UTF-8 and a language tag is ignored", () => {
    expect(decodeEncodedWords(`=?x-unknown?B?${Buffer.from("ok").toString("base64")}?=`)).toBe("ok");
    expect(decodeEncodedWords("=?ISO-8859-1*de?Q?M=FCnchen?=")).toBe("München");
  });
});

describe("gmail headers", () => {
  it("decodes the subject and the display names of From, To and Cc, keeping a quoted comma out of the split", () => {
    const name = `=?UTF-8?B?${Buffer.from(RU).toString("base64")}?=`;
    const msg = normalizeGmailMessage({
      id: "m1",
      labelIds: ["INBOX"],
      internalDateMs: Date.parse("2026-11-16T10:00:00Z"),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "Subject", value: "=?ISO-8859-1?Q?Gr=FC=DFe_aus_M=FCnchen?=" },
          { name: "From", value: `${name} <ivan@example.org>` },
          { name: "To", value: `=?ISO-8859-1?Q?M=FCller=2C_J=F6rg?= <joerg@example.net>, "=?UTF-8?Q?Ana?=" <ana@example.com>` },
          { name: "Cc", value: "=?UTF-8?B?broken <cc@example.com>" },
          { name: "Content-Type", value: "text/plain; charset=windows-1251" },
        ],
        body: { data: b64url(ru1251) },
      },
    });
    expect(msg.subject).toBe(DE);
    expect(msg.from).toEqual({ name: RU, email: "ivan@example.org" });
    expect(msg.to).toEqual([{ name: "Müller, Jörg", email: "joerg@example.net" }, { name: "Ana", email: "ana@example.com" }]);
    expect(msg.cc).toEqual([{ name: "=?UTF-8?B?broken", email: "cc@example.com" }]);
    expect(msg.bodyText).toBe(RU);
    expect(parseAddressList("Plain Name <p@example.org>")).toEqual([{ name: "Plain Name", email: "p@example.org" }]);
  });
});
