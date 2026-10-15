// Normalises POST /admin/api/tool responses and narrows each tool's `data`
// to the fields the panel renders. Nothing here trusts the shape: every field
// is read through a guard, a missing list becomes [], and a field of the wrong
// type becomes null or a placeholder. Only a body that is not an object at all
// throws ToolShapeError.

export class ToolError extends Error {
  code: string;
  status: number;
  suggestion?: string;
  retryAfterS?: number;
  constructor(code: string, message: string, status: number, suggestion?: string, retryAfterS?: number) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.status = status;
    if (suggestion !== undefined) this.suggestion = suggestion;
    if (retryAfterS !== undefined) this.retryAfterS = retryAfterS;
  }
}

export class ToolShapeError extends Error {
  constructor(message = "Unexpected response shape") {
    super(message);
    this.name = "ToolShapeError";
  }
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function strOr(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}
function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function objs(v: unknown): Obj[] {
  return arr(v).filter(isObj);
}
function strings(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}
function idOf(v: unknown): string {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? String(v) : "";
}
function root(d: unknown): Obj {
  if (!isObj(d)) throw new ToolShapeError();
  return d;
}

export function normalizeToolResponse(status: number, body: unknown): unknown {
  if (status === 401) throw new ToolError("unauthorized", "Admin session expired", 401);
  if (status === 429) {
    const b = isObj(body) ? body : {};
    const retry = numOrNull(b.retry_after_s) ?? 2;
    throw new ToolError("rate_limited", strOr(b.message, "Rate limited"), 429, str(b.suggestion) ?? undefined, retry);
  }
  if (!isObj(body)) throw new ToolShapeError();
  if (status >= 200 && status < 300 && body.ok === true) return body.data;
  const code = str(body.error) ?? `http_${status}`;
  throw new ToolError(code, str(body.message) ?? code, status, str(body.suggestion) ?? undefined);
}

export function pageHitSlug(sourcePath: string): string | null {
  if (typeof sourcePath !== "string" || !sourcePath.startsWith("page://")) return null;
  const slug = sourcePath.slice(7);
  return slug === "" ? null : slug;
}

// search
export interface SearchHit {
  chunkId: string;
  sourcePath: string;
  title: string | null;
  content: string;
  score: number | null;
  slug: string | null;
}
export interface SearchResult { hits: SearchHit[]; hint: string | null }

export function parseSearch(d: unknown): SearchResult {
  const o = root(d);
  const hits = objs(o.hits).map((h) => {
    const sourcePath = strOr(h.sourcePath, "");
    return {
      chunkId: idOf(h.chunkId),
      sourcePath,
      title: str(h.title),
      content: strOr(h.content, ""),
      score: numOrNull(h.score),
      slug: pageHitSlug(sourcePath),
    };
  });
  return { hits, hint: str(o.hint) };
}

// resolve_slugs
export interface SlugHit { slug: string; title: string | null; score: number | null }

export function parseResolveSlugs(d: unknown): SlugHit[] {
  return objs(root(d).hits)
    .map((h) => ({ slug: strOr(h.slug, ""), title: str(h.title), score: numOrNull(h.score) }))
    .filter((h) => h.slug !== "");
}

// page_get
export interface Page {
  slug: string;
  type: string | null;
  title: string | null;
  markdown_body: string;
  created_at: string | null;
  updated_at: string | null;
  source_id: string | null;
}

function parsePageRow(p: Obj): Page {
  return {
    slug: strOr(p.slug, ""),
    type: str(p.type),
    title: str(p.title),
    markdown_body: strOr(p.markdown_body, ""),
    created_at: str(p.created_at),
    updated_at: str(p.updated_at),
    source_id: str(p.source_id),
  };
}

export function parsePageGet(
  d: unknown,
): { kind: "page"; page: Page; version: number; quarantined: boolean } | { kind: "ambiguous"; candidates: string[] } {
  const o = root(d);
  if (o.ok === false && o.error === "ambiguous_slug") return { kind: "ambiguous", candidates: strings(o.candidates) };
  const page = parsePageRow(isObj(o.page) ? o.page : {});
  return { kind: "page", page, version: numOrNull(o.version) ?? 0, quarantined: isObj(o.quarantined) || o.quarantined === true };
}

// page_list
export interface PageListRow {
  slug: string;
  type: string | null;
  title: string | null;
  updated_at: string | null;
  created_at: string | null;
  source_id: string | null;
}

export function parsePageList(d: unknown): PageListRow[] {
  return objs(root(d).pages)
    .map((p) => ({
      slug: strOr(p.slug, ""),
      type: str(p.type),
      title: str(p.title),
      updated_at: str(p.updated_at),
      created_at: str(p.created_at),
      source_id: str(p.source_id),
    }))
    .filter((p) => p.slug !== "");
}

// page_versions
export interface PageVersion {
  version_n: number | null;
  written_by: string | null;
  written_at: string | null;
  body_snapshot: string;
}

export function parsePageVersions(d: unknown): PageVersion[] {
  return objs(root(d).versions).map((v) => ({
    version_n: numOrNull(v.version_n),
    written_by: str(v.written_by) ?? str(v.written_by_principal),
    written_at: str(v.written_at),
    body_snapshot: strOr(v.body_snapshot, ""),
  }));
}

// get_links
export interface Link {
  id: string;
  source_slug: string;
  target_slug: string;
  type: string;
  confidence: number | null;
  context: string | null;
}
export interface LinkGroup { type: string; direction: "outbound" | "inbound"; links: Link[] }

function parseLink(l: Obj): Link {
  return {
    id: idOf(l.id),
    source_slug: strOr(l.source_slug, ""),
    target_slug: strOr(l.target_slug, ""),
    type: strOr(l.type, "link"),
    confidence: numOrNull(l.inferred_confidence),
    context: str(l.context),
  };
}

export function parseGetLinks(d: unknown): LinkGroup[] {
  return objs(root(d).groups).map((g) => ({
    type: strOr(g.type, "link"),
    direction: g.direction === "inbound" ? "inbound" : "outbound",
    links: objs(g.links).map(parseLink),
  }));
}

// get_tags
export function parseGetTags(d: unknown): string[] {
  return strings(root(d).tags);
}

// graph_neighbors
export interface NeighborEdge extends Link { direction: "outbound" | "inbound" }

export function parseGraphNeighbors(d: unknown): NeighborEdge[] {
  return objs(root(d).links)
    .map((l) => ({ ...parseLink(l), direction: l.direction === "inbound" ? "inbound" as const : "outbound" as const }))
    .filter((l) => l.source_slug !== "" && l.target_slug !== "");
}

// facts
export interface Fact {
  id: string;
  entity_slug: string | null;
  fact: string;
  confidence: number | null;
  kind: string | null;
  source_slug: string | null;
  written_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  visibility: string | null;
  superseded_by: string | null;
}

function parseFact(f: Obj): Fact {
  const sup = idOf(f.superseded_by);
  return {
    id: idOf(f.id),
    entity_slug: str(f.entity_slug),
    fact: strOr(f.fact, ""),
    confidence: numOrNull(f.confidence),
    kind: str(f.kind),
    source_slug: str(f.source_slug),
    written_at: str(f.written_at),
    valid_from: str(f.valid_from),
    valid_until: str(f.valid_until),
    visibility: str(f.visibility),
    superseded_by: sup === "" ? null : sup,
  };
}

export function parseFacts(d: unknown, key: "facts" | "supersessions"): Fact[] {
  return objs(root(d)[key]).map(parseFact);
}

export function parseRecall(d: unknown): Fact | null {
  const o = root(d);
  return isObj(o.fact) ? parseFact(o.fact) : null;
}

// timeline
export interface TimelineEntry {
  id: string;
  occurred_at: string | null;
  event: string;
  detail: string | null;
  source_label: string | null;
}

function parseTimelineRows(v: unknown): TimelineEntry[] {
  return objs(v).map((t) => ({
    id: idOf(t.id),
    occurred_at: str(t.occurred_at),
    event: strOr(t.event, ""),
    detail: str(t.detail),
    source_label: str(t.source_label),
  }));
}

export function parseEntityTimeline(d: unknown): TimelineEntry[] {
  return parseTimelineRows(root(d).timeline);
}

// entity_recall
export interface EntityRecall {
  slug: string;
  page: Page | null;
  facts: Fact[];
  timeline: TimelineEntry[];
  pendingConsolidation: number | null;
}

export function parseEntityRecall(d: unknown): EntityRecall {
  const o = root(d);
  return {
    slug: strOr(o.slug, ""),
    page: isObj(o.page) ? parsePageRow(o.page) : null,
    facts: objs(o.facts).map(parseFact),
    timeline: parseTimelineRows(o.timeline),
    pendingConsolidation: numOrNull(o.pending_consolidation_count),
  };
}

// chronicle_*
export interface ChronicleEvent {
  date: string | null;
  summary: string;
  detail: string | null;
  slug: string | null;
  kind: string | null;
}

export function parseChronicle(d: unknown): ChronicleEvent[] {
  return objs(root(d).events).map((e) => ({
    date: str(e.date),
    summary: strOr(e.summary, ""),
    detail: str(e.detail),
    slug: str(e.slug) ?? str(e.event_slug),
    kind: str(e.kind),
  }));
}

// add_tag / remove_tag
export function parseTagWrite(d: unknown): { slug: string; tag: string } {
  const o = root(d);
  return { slug: strOr(o.slug, ""), tag: strOr(o.tag, "") };
}
