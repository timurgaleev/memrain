export const PAGE_BODY_MAX_BYTES = 256 * 1024;
const MAX_HEADINGS = 200;
const MAX_HEADING_CHARS = 200;

export interface PageWindowOptions {
  offset?: number;
  maxBytes?: number;
}

interface HeadingOffset {
  text: string;
  level: number;
  offset: number;
}

function headingOffsets(body: string): { headings: HeadingOffset[]; headings_truncated: boolean } {
  let headings: HeadingOffset[] = [];
  let characterOffset = 0;
  let byteOffset = 0;
  let fence: { marker: string; length: number } | undefined;
  while (characterOffset < body.length) {
    const newline = body.indexOf("\n", characterOffset);
    const end = newline === -1 ? body.length : newline + 1;
    const line = body.slice(characterOffset, end);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length &&
        line.slice(marker[0].length).trim() === "") fence = undefined;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[ \t]+([^\r\n]*)/.exec(line);
      if (heading) {
        if (headings.length === MAX_HEADINGS) return { headings, headings_truncated: true };
        const text = heading[2]!.trim().slice(0, MAX_HEADING_CHARS);
        headings = [...headings, { text, level: heading[1]!.length, offset: byteOffset }];
      }
    }
    byteOffset += Buffer.byteLength(line, "utf8");
    characterOffset = end;
  }
  return { headings, headings_truncated: false };
}

export function pageBodyWindow(body: string, options: PageWindowOptions = {}) {
  const totalBytes = Buffer.byteLength(body, "utf8");
  if (options.offset === undefined && options.maxBytes === undefined && totalBytes <= PAGE_BODY_MAX_BYTES) return null;
  const offset = options.offset ?? 0;
  const maxBytes = options.maxBytes ?? PAGE_BODY_MAX_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > PAGE_BODY_MAX_BYTES) {
    throw new RangeError("page window requires a non-negative byte offset and maxBytes between 4 and 262144");
  }
  const bytes = Buffer.from(body, "utf8");
  let start = Math.min(offset, totalBytes);
  while (start < totalBytes && (bytes[start]! & 0xc0) === 0x80) start++;
  let end = Math.min(start + maxBytes, totalBytes);
  while (end < totalBytes && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    body_window: bytes.subarray(start, end).toString("utf8"),
    partial: start > 0 || end < totalBytes,
    offset: start,
    total_bytes: totalBytes,
    next_offset: end < totalBytes ? end : null,
    ...headingOffsets(body),
    notice: "This is a page body window. Use page_edit or page_append for changes; do not send an excerpt to page_put.",
  };
}
