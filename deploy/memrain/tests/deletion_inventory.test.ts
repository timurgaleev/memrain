/**
 * Deletion inventory — every table that names a page or a source has a stated
 * fate when that page is purged or that source is deleted.
 *
 * The lists are read from the live catalog on both engines, so a migration
 * that adds a `…slug` or `source_id` column fails here until the column is
 * given a disposition below. Each disposition is checked against the catalog
 * or the purge code where that is possible:
 *
 *   cascade      a foreign key to pages(slug) / sources(id) whose delete rule
 *                removes, nulls or blocks the row (checked in the catalog)
 *   leftover     deleted by slug in the page purge transaction (pages-purge.ts)
 *   retired      facts written on the page are retired by the purge
 *   referenced   counted by sourceReferences, so deleting the source is refused
 *   via          hangs off a parent row by a cascading foreign key (checked)
 *   exempt       outlives the page/source on purpose; the reason says why
 *   gap          known to survive and should not; listed in TODO.md. This list
 *                may only shrink.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { LEFTOVER_TABLES } from "../src/core/pages-purge.ts";
import { sourceReferences } from "../src/core/sources.ts";
import { eraseMemberPersonalSource } from "../src/core/member-offboarding.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

setDefaultTimeout(60000);

type Disposition =
  | { kind: "cascade" }
  | { kind: "leftover" }
  | { kind: "retired" }
  | { kind: "referenced" }
  | { kind: "via"; parent: string }
  | { kind: "exempt"; reason: string }
  | { kind: "gap"; reason: string };

/** `table.column` for each column whose name ends in `slug`, i.e. names a page. */
const PAGE_COLUMNS: Record<string, Disposition> = {
  "page_versions.slug": { kind: "cascade" },
  "page_aliases.slug": { kind: "cascade" },
  "links.source_slug": { kind: "cascade" },
  "timeline_events.slug": { kind: "cascade" },
  "timeline_events.event_slug": { kind: "cascade" },
  "wanted_links.from_slug": { kind: "cascade" },
  "raw_data.slug": { kind: "leftover" },
  "tags.slug": { kind: "leftover" },
  "slug_aliases.canonical_slug": { kind: "leftover" },
  "context_volunteer_events.slug": { kind: "leftover" },
  "entity_facts.source_slug": { kind: "retired" },
  "entity_facts.source_markdown_slug": { kind: "retired" },
  "entity_facts.entity_slug": { kind: "exempt", reason: "the subject of facts written elsewhere; facts written on the purged page are retired through their writing-page columns" },
  "links.target_slug": { kind: "exempt", reason: "a link from a live page to a missing slug is how a wanted page is recorded; the row goes with its source page" },
  "links.origin_slug": { kind: "exempt", reason: "provenance label on a link between two live pages; the link itself stays valid" },
  "slug_aliases.alias_slug": { kind: "exempt", reason: "a rename redirect from a purged old name to a live page is kept on purpose (pages-purge header)" },
  "wanted_links.target_slug": { kind: "exempt", reason: "the target of a wanted link is by definition a page that does not exist" },
  "fact_purge_receipts.page_slug": { kind: "exempt", reason: "the purge receipt is the undo record and must outlive the page it names" },
  "secret_store_occurrences.slug": { kind: "exempt", reason: "removed by purgeSecretOriginals in every hard page delete (pages-purge, connector retention), which also drops the originals no other page holds" },
  "page_purges.slug": { kind: "exempt", reason: "the purge tombstone exists to outlive the page it names, so its text is not written back (migration 178)" },
  "fact_withdrawals.entity_slug": { kind: "exempt", reason: "a withdrawal is keyed by claim and subject so a withdrawn claim does not come back on re-extraction" },
  "facts_backfill_scans.slug": { kind: "exempt", reason: "a memo keyed by body hash; a later page on the slug with a different body never matches it (migration 111)" },
  "synth_concepts.concept_slug": { kind: "exempt", reason: "concepts are their own namespace of synthesis rows, not pages" },
  "synth_concept_atoms.concept_slug": { kind: "exempt", reason: "provenance of a concept row, which is not a page" },
  "hot_memory.entity_slug": { kind: "exempt", reason: "observation inbox keyed by entity subject, not by the page it was seen on" },
  "hot_memory.source_slug": { kind: "leftover" },
  "synthesis_evidence.synthesis_slug": { kind: "leftover" },
  "write_gate_row_holds.slug": { kind: "leftover" },
  "loop_threads.page_slug": { kind: "cascade" },
  "open_loops.page_slug": { kind: "cascade" },
  "chat_messages.saved_slug": { kind: "exempt", reason: "names the page a chat answer was saved as; the answer is the owner's own record and outlives a purge of that page" },
  "retrieval_feedback.slug": { kind: "cascade" },
  "retrieval_weights.slug": { kind: "cascade" },
  "connector_items.page_slug": { kind: "exempt", reason: "the sync's record of which provider item a page came from; it outlives a page the owner purged so the next run does not recreate it, and goes with its account by cascade" },
};

/** Tables with a `source_id` column. */
const SOURCE_TABLES: Record<string, Disposition> = {
  "documents": { kind: "cascade" },
  "pages": { kind: "cascade" },
  "entity_facts": { kind: "cascade" },
  "links": { kind: "cascade" },
  "tags": { kind: "cascade" },
  "timeline_events": { kind: "cascade" },
  "synth_calibration_profile": { kind: "cascade" },
  "oauth_clients": { kind: "cascade" },
  "code_edges_symbol": { kind: "cascade" },
  "connector_accounts": { kind: "cascade" },
  "connector_oauth_states": { kind: "cascade" },
  "write_gate_holds": { kind: "cascade" },
  "write_gate_receipts": { kind: "cascade" },
  "write_gate_row_holds": { kind: "cascade" },
  "trust_proposals": { kind: "cascade" },
  "secret_store": { kind: "cascade" },
  "notifications": { kind: "cascade" },
  "open_loops": { kind: "cascade" },
  "loop_suppressions": { kind: "cascade" },
  "loop_threads": { kind: "cascade" },
  "group_sources": { kind: "cascade" },
  "chat_threads": { kind: "cascade" },
  "retrieval_feedback": { kind: "cascade" },
  "retrieval_weights": { kind: "cascade" },
  "page_versions": { kind: "referenced" },
  "oauth_tokens": { kind: "referenced" },
  "oauth_codes": { kind: "referenced" },
  "oauth_enrollments": { kind: "referenced" },
  "chunks": { kind: "via", parent: "documents" },
  "page_aliases": { kind: "via", parent: "pages" },
  "wanted_links": { kind: "via", parent: "pages" },
  "context_volunteer_events": { kind: "exempt", reason: "the column is kept for row shape only; every write leaves it NULL (migration 044)" },
  "facts_backfill_scans": { kind: "exempt", reason: "a body-hash memo that never matches content written under a new source" },
  "fact_purge_receipts": { kind: "exempt", reason: "ids-only undo and audit receipts, kept after the source is gone" },
  "page_purges": { kind: "exempt", reason: "content hashes only, no text; a tombstone of a deleted source never matches a write elsewhere" },
  "secret_audit_runs": { kind: "exempt", reason: "operator audit history of counts and ids, no content" },
  "owner_only_retired_sources": { kind: "exempt", reason: "remembers that a deleted source was owner-only, so what was derived from it stays closed; ids only, no content" },
  "daemon_controls": { kind: "exempt", reason: "operator switches keyed by source id ('*' for all); a row for a deleted source is inert, since the scheduler only targets sources that exist, and holds no content" },
  "fact_withdrawals": { kind: "gap", reason: "withdrawals survive the source; a new source with the same id inherits them" },
  "ingest_log": { kind: "gap", reason: "the log survives the source; a new source with the same id reads it" },
  "slug_aliases": { kind: "gap", reason: "aliases survive the source; a new source with the same id inherits its redirects" },
  "synth_contradictions": { kind: "gap", reason: "findings survive the source; a new source with the same id reads them" },
  "take_nudge_log": { kind: "gap", reason: "the nudge log survives the source; a new source with the same id inherits it" },
};

// Each is a TODO.md item ("Deletion inventory gaps"). Fix one, then delete its line.
const KNOWN_GAPS = [
  "fact_withdrawals",
  "ingest_log",
  "slug_aliases",
  "synth_contradictions",
  "take_nudge_log",
];

interface ForeignKey { table: string; column: string; ref: string; del: string }

async function catalog(open: () => Promise<{ storage: { engine(): { query<T>(sql: string, p?: unknown[]): Promise<{ rows: T[] }> } }; close(): Promise<void> }>) {
  const { storage, close } = await open();
  try {
    const engine = storage.engine();
    const cols = await engine.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND (c.column_name LIKE '%slug' OR c.column_name = 'source_id')`,
    );
    const fks = await engine.query<ForeignKey>(
      `SELECT conrelid::regclass::text AS table, confrelid::regclass::text AS ref, confdeltype::text AS del,
              (SELECT attname FROM pg_attribute WHERE attrelid = conrelid AND attnum = conkey[1]) AS column
         FROM pg_constraint
        WHERE contype = 'f' AND array_length(conkey, 1) = 1`,
    );
    return { cols: cols.rows, fks: fks.rows };
  } finally {
    await close();
  }
}

// a = no action, r = restrict (both block the delete), c = cascade, n = set null.
const COVERING_RULES = new Set(["a", "r", "c", "n"]);

function check(
  key: string,
  table: string,
  column: string,
  ref: "pages" | "sources",
  d: Disposition | undefined,
  fks: ForeignKey[],
): string | null {
  if (!d) return `${key}: names a ${ref === "pages" ? "page" : "source"} but has no disposition`;
  const fk = (t: string, c: string, r: string) => fks.find(f => f.table === t && f.column === c && f.ref === r);
  switch (d.kind) {
    case "cascade": {
      const f = fk(table, column, ref);
      if (!f) return `${key}: declared cascade but no foreign key to ${ref}`;
      if (ref === "pages" && f.del !== "c") return `${key}: foreign key to pages does not cascade (${f.del})`;
      if (!COVERING_RULES.has(f.del)) return `${key}: foreign key delete rule ${f.del} covers nothing`;
      return null;
    }
    case "leftover":
      return LEFTOVER_TABLES.some(([, t, c]) => t === table && c === column)
        ? null
        : `${key}: declared leftover but pages-purge LEFTOVER_TABLES does not delete it`;
    case "retired":
      return table === "entity_facts" && ["source_slug", "source_markdown_slug"].includes(column)
        ? null
        : `${key}: only the facts' writing-page columns are retired by the purge`;
    case "referenced":
      return new RegExp(`FROM\\s+${table}\\s+WHERE`).test(sourceReferences.toString())
        ? null
        : `${key}: declared referenced but sourceReferences does not count it`;
    case "via": {
      const f = fks.find(x => x.table === table && x.ref === d.parent && x.del === "c");
      return f ? null : `${key}: no cascading foreign key to ${d.parent}`;
    }
    case "exempt":
    case "gap":
      return d.reason.trim().length >= 20 ? null : `${key}: ${d.kind} needs a reason`;
  }
}

describe("deletion inventory", () => {
  it("lists exactly the known gaps", () => {
    const gaps = [
      ...Object.entries(PAGE_COLUMNS).filter(([, d]) => d.kind === "gap").map(([k]) => k),
      ...Object.entries(SOURCE_TABLES).filter(([, d]) => d.kind === "gap").map(([k]) => k),
    ].sort();
    expect(gaps).toEqual([...KNOWN_GAPS].sort());
  });

  for (const engine of storageEngines(process.env["MEMRAIN_TEST_POSTGRES_URL"])) {
    it(`covers every page and source column in the ${engine.name} catalog`, async () => {
      const { cols, fks } = await catalog(engine.open);
      const problems: string[] = [];
      const pageKeys = cols.filter(c => c.column_name.endsWith("slug")).map(c => `${c.table_name}.${c.column_name}`);
      const sourceKeys = cols.filter(c => c.column_name === "source_id").map(c => c.table_name);
      for (const key of pageKeys) {
        if (key === "pages.slug") continue;
        const [table, column] = key.split(".") as [string, string];
        const p = check(key, table, column, "pages", PAGE_COLUMNS[key], fks);
        if (p) problems.push(p);
      }
      for (const table of sourceKeys) {
        if (table === "sources") continue;
        const p = check(table, table, "source_id", "sources", SOURCE_TABLES[table], fks);
        if (p) problems.push(p);
      }
      for (const key of Object.keys(PAGE_COLUMNS)) if (!pageKeys.includes(key)) problems.push(`${key}: stale entry, no such column`);
      for (const key of Object.keys(SOURCE_TABLES)) if (!sourceKeys.includes(key)) problems.push(`${key}: stale entry, no source_id column`);
      expect(problems).toEqual([]);
    });
  }
});

/**
 * Tables that name a member (`member_id`) and their fate when a member is
 * removed with its personal source (core/member-offboarding.ts):
 *   erased     deleted by the offboarding transaction (checked in its code)
 *   revoked    kept as a dead row, revoked by the offboarding (checked)
 *   exempt     outlives the member on purpose; the reason says why
 * A new member_id column fails here until it is given a fate.
 */
type MemberDisposition = { kind: "erased" } | { kind: "revoked" } | { kind: "exempt"; reason: string };

const MEMBER_TABLES: Record<string, MemberDisposition> = {
  "member_passkeys": { kind: "erased" },
  "member_invites": { kind: "erased" },
  "onboarding_state": { kind: "erased" },
  "group_members": { kind: "erased" },
  "member_web_sessions": { kind: "revoked" },
  "access_tokens": { kind: "revoked" },
  "oauth_enrollments": { kind: "revoked" },
  "oauth_clients": { kind: "exempt", reason: "a client bound to a member stays bound to the tombstone, so the verifier refuses it; the operator revokes the client" },
  "member_audit": { kind: "exempt", reason: "the member history, including the erasure receipt, outlives the member on purpose" },
};

describe("member deletion inventory", () => {
  for (const engine of storageEngines(process.env["MEMRAIN_TEST_POSTGRES_URL"])) {
    it(`gives every member_id column in the ${engine.name} catalog a fate`, async () => {
      const { storage, close } = await engine.open();
      let tables: string[];
      try {
        const r = await storage.engine().query<{ table_name: string }>(
          `SELECT c.table_name FROM information_schema.columns c
             JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'member_id'`,
        );
        tables = r.rows.map(x => x.table_name).sort();
      } finally {
        await close();
      }
      const code = eraseMemberPersonalSource.toString();
      const problems: string[] = [];
      for (const table of tables) {
        const d = MEMBER_TABLES[table];
        if (!d) problems.push(`${table}: names a member but has no fate`);
        else if (d.kind === "erased" && !new RegExp(`DELETE FROM ${table} WHERE member_id`).test(code)) problems.push(`${table}: declared erased but the offboarding does not delete it`);
        else if (d.kind === "revoked" && !new RegExp(`UPDATE ${table} SET revoked_at = now\\(\\) WHERE member_id`).test(code)) problems.push(`${table}: declared revoked but the offboarding does not revoke it`);
        else if (d.kind === "exempt" && d.reason.trim().length < 20) problems.push(`${table}: exempt needs a reason`);
      }
      for (const key of Object.keys(MEMBER_TABLES)) if (!tables.includes(key)) problems.push(`${key}: stale entry, no member_id column`);
      expect(problems).toEqual([]);
    });
  }
});
