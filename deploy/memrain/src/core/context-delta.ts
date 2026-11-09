import type { Storage } from "./storage.ts";
import { OperationError } from "./operation-error.ts";
import { isCalendarDate } from "./effective-date.ts";
import { andSourceScope, isNoGrant } from "./source-scope.ts";
import { eligibleFactSql, eligiblePageSql, readLimit } from "./bounded-read.ts";
import { frameExternal, readExternalTrust } from "./trust-frame.ts";
export interface ContextDeltaOptions { since: string; limit?: number; sourceIds?: string[]; remote?: boolean }
interface DeltaPage { slug: string; source_id: string; type: string; updated_at: string }
interface DeltaFact { id: number; entity_slug: string; source_id: string; fact: string; written_at: string }
interface DeltaEvent { id: number; slug: string; source_id: string; event_slug: string | null; date: string; summary: string }

export async function readContextDelta(storage: Storage, opts: ContextDeltaOptions) {
  const limit = readLimit(opts.limit);
  if (typeof opts.since !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(opts.since)
      || !isCalendarDate(opts.since.slice(0, 10)) || !Number.isFinite(Date.parse(opts.since))) {
    throw new OperationError("invalid_params", "since must be a calendar date or UTC ISO timestamp");
  }
  const since = new Date(opts.since).toISOString();
  if (opts.since.length > 10 && since.slice(0, 19) !== opts.since.slice(0, 19)) {
    throw new OperationError("invalid_params", "since must use a valid UTC clock time");
  }
  const e = storage.engine();
  const query = async <T>(select: string, from: string, predicate: string, scopeColumn: string, order: string) => {
    if (isNoGrant(opts.sourceIds)) return [] as T[];
    const params: unknown[] = [since, limit + 1];
    const scope = andSourceScope(scopeColumn, opts.sourceIds, params);
    return (await e.query<T>(`SELECT ${select} FROM ${from} WHERE ${predicate}${scope} ORDER BY ${order} LIMIT $2`, params)).rows;
  };
  const [pages, facts, events] = await Promise.all([
    query<DeltaPage>("p.slug, p.source_id, p.type, p.updated_at::text AS updated_at", "pages p",
      `p.updated_at >= $1::timestamptz AND ${eligiblePageSql("p", opts.remote === true)}`, "p.source_id", 'p.updated_at DESC, p.slug COLLATE "C", p.source_id COLLATE "C"'),
    query<DeltaFact>("f.id, f.entity_slug, f.source_id, f.fact, f.written_at::text AS written_at", "entity_facts f",
      `f.written_at >= $1::timestamptz AND ${eligibleFactSql("f", opts.remote === true)}`, "f.source_id", "f.written_at DESC, f.id DESC"),
    query<DeltaEvent>("te.id, te.slug, te.source_id, te.event_slug, (te.occurred_at AT TIME ZONE 'UTC')::date::text AS date, te.event AS summary",
      "timeline_events te JOIN pages p ON p.slug = te.slug AND p.source_id = te.source_id LEFT JOIN pages ep ON ep.slug = te.event_slug AND ep.source_id = te.source_id",
      `(te.occurred_at AT TIME ZONE 'UTC')::date >= ($1::timestamptz AT TIME ZONE 'UTC')::date AND ${eligiblePageSql("p", opts.remote === true)}
       AND (te.event_slug IS NULL OR (ep.slug IS NOT NULL AND ${eligiblePageSql("ep", opts.remote === true)}))`, "te.source_id", "te.occurred_at DESC, te.id DESC"),
  ]);
  const selectedFacts = facts.slice(0, limit).map(row => ({ ...row, id: Number(row.id) }));
  const selectedEvents = events.slice(0, limit).map(row => ({ ...row, id: Number(row.id) }));
  const trust = await readExternalTrust(e, { facts: selectedFacts.map(row => row.id), events: selectedEvents.map(row => row.id),
    pages: selectedEvents.flatMap(row => row.event_slug ? [row.event_slug] : []) }, opts.sourceIds);
  return { since, complete_change_log: false,
    pages: { items: pages.slice(0, limit), truncated: pages.length > limit, time_basis: "updated_at" },
    facts: { items: selectedFacts.map(row => trust.facts.has(row.id) ? { ...row, fact: frameExternal(row.fact), trust: "external" } : row),
      truncated: facts.length > limit, time_basis: "written_at" },
    events: { items: selectedEvents.map(row => trust.events.has(row.id) || (row.event_slug && trust.pages.has(row.event_slug))
      ? { ...row, summary: frameExternal(row.summary), trust: "external" } : row),
      truncated: events.length > limit, time_basis: "event_date" } };
}
