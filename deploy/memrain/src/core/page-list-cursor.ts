import { OperationError } from "./operation-error.ts";

export interface PageListPosition {
  slug: string;
  key: string | null;
}

export function encodePageListCursor(context: string, position: PageListPosition): string {
  return Buffer.from(JSON.stringify({ v: 1, context, ...position })).toString("base64url");
}

export function decodePageListCursor(cursor: string, context: string, timestamp: boolean): PageListPosition {
  const invalid = () => new OperationError("invalid_params", "Invalid page_list cursor or changed listing filters.",
    "Start a new page_list without cursor when changing filters, sort order or source access.");
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let data: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw invalid();
    data = JSON.parse(decoded.toString("utf8"));
  } catch { throw invalid(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const r = data as Record<string, unknown>;
  if (r.v !== 1 || r.context !== context || Object.keys(r).length !== 4 ||
      typeof r.slug !== "string" || r.slug.length === 0 || r.slug.length > 256 || /[\u0000-\u001f]/.test(r.slug)) throw invalid();
  if (timestamp) {
    if (typeof r.key !== "string" || r.key.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(r.key) ||
        !Number.isFinite(Date.parse(r.key))) throw invalid();
  } else if (r.key !== null) throw invalid();
  return { slug: r.slug, key: r.key as string | null };
}
