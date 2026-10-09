/**
 * Two-tenant fixture shared by the isolation suites: sources 'tenantA' and
 * 'tenantB' with deliberately colliding identifiers (entity name, code symbol,
 * source path, page title, graph start, search keyword) and per-tenant
 * distinctive tokens, so any read that crosses the source boundary is visible
 * as the other tenant's token in the response.
 */
import { putPage } from "../../src/core/pages.ts";
import { addFact } from "../../src/core/facts.ts";
import { addLink } from "../../src/core/links.ts";
import { registerSource } from "../../src/core/sources.ts";
import { indexPageIntoSearch } from "../../src/core/page-index.ts";
import { entityId, type EntityType } from "../../src/core/entities.ts";
import type { Storage } from "../../src/core/storage.ts";
import type { AuthInfo } from "../../src/core/auth-info.ts";
import { deterministicEmbed } from "../det-embed.ts";

const embedFn = async (text: string) => deterministicEmbed(text);

export const A = "tenantA";
export const B = "tenantB";

// --- Colliding identifiers (shared across BOTH tenants) --------------------
export const ENTITY_SLUG = "people/alice"; // one global page; facts/timeline per-source
export const WIKI_NAME = "Alice"; // shared wikilink entity — backlinks collision
export const CODE_SYM = "processPayment"; // shared code symbol — code_* collision
export const SHARED_PATH = "/shared/pay.ts"; // shared source_path — code_callees collision
export const SHARED_TITLE = "Aardvark Shared Title"; // shared page title — resolve_slugs
export const GATEWAY = "shared/gateway"; // shared graph start — traversal collision
export const KEYWORD = "kangaroo"; // shared search keyword

// --- Per-tenant DISTINCTIVE private tokens ---------------------------------
export const A_FACT = "AAA_FACT_TRAJECTORY_seed";
export const B_FACT = "BBB_FACT_TRAJECTORY_seed";
export const A_EVENT = "AAA_EVENT_TRAJECTORY_launch";
export const B_EVENT = "BBB_EVENT_TRAJECTORY_launch";
export const A_BODY = "AAA_SECRET_NOTES_BODY";
export const B_BODY = "BBB_SECRET_NOTES_BODY";
export const A_CALLEE = "chargeCardAAA";
export const B_CALLEE = "chargeCardBBB";
export const A_CALLER = "callerAAA";
export const B_CALLER = "callerBBB";
export const A_TAKE = "AAA_TAKE_SECRET_claim";
export const B_TAKE = "BBB_TAKE_SECRET_claim";
export const A_SEARCH = "KANGA_SECRET_AAA";
export const B_SEARCH = "KANGA_SECRET_BBB";

// Document ids (TEXT PK, chosen so synth_takes.source_ref can point at them).
export const DOC_A_NOTES = "doc-a-notes";
export const DOC_B_NOTES = "doc-b-notes";
export const DOC_A_CODE = "doc-a-code";
export const DOC_B_CODE = "doc-b-code";

export function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

/**
 * Seed both tenants into an initialised store. Returns the fact ids the recall
 * checks need.
 */
export async function seedTenantContract(storage: Storage): Promise<{ factIdA: number; factIdB: number }> {
  /** Insert one document row carrying a source_id. */
  async function seedDoc(id: string, path: string, title: string, source: string) {
    await storage.engine().query(
      `INSERT INTO documents (id, source_path, title, source_id) VALUES ($1, $2, $3, $4)`,
      [id, path, title, source],
    );
  }

  /** Insert one chunk (line range + qualified symbol optional for code reads). */
  async function seedChunk(
    id: string,
    docId: string,
    idx: number,
    content: string,
    startLine: number | null = null,
    endLine: number | null = null,
    symbolQualified: string | null = null,
  ) {
    await storage.engine().query(
      `INSERT INTO chunks (id, document_id, chunk_index, content, start_line, end_line, symbol_name_qualified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, docId, idx, content, startLine, endLine, symbolQualified],
    );
  }

  /** Ensure an entity row exists, then attach a mention on a chunk. */
  async function seedMention(
    type: EntityType,
    name: string,
    chunkId: string,
    surfaceForm: string,
  ) {
    const eid = entityId(type, name);
    await storage.engine().query(
      `INSERT INTO entities (id, type, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [eid, type, name],
    );
    await storage.engine().query(
      `INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES ($1, $2, $3)`,
      [chunkId, eid, surfaceForm],
    );
  }

  async function seedCodeEdge(
    fromChunk: string,
    fromSym: string,
    toSym: string,
    source: string,
  ) {
    await storage.engine().query(
      `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id)
       VALUES ($1, $2, $3, 'calls', $4)`,
      [fromChunk, fromSym, toSym, source],
    );
  }


  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  // --- Shared entity page + per-source facts / timeline (trajectory, recall) ---
  await putPage(storage, { slug: ENTITY_SLUG, type: "person", title: "Alice Entity" });
  const fa = await addFact(storage, { entity_slug: ENTITY_SLUG, fact: A_FACT, source_id: A });
  const fb = await addFact(storage, { entity_slug: ENTITY_SLUG, fact: B_FACT, source_id: B });
  // The shared entity page is owned by 'default', so addTimelineEvent's ownership
  // guard (a scoped caller may only annotate a page its own source owns) blocks a
  // per-source append here. Seed the two events directly to build the cross-source
  // ledger this test asserts find_trajectory keeps READ-scoped.
  const seedEvent = (occurredAt: string, event: string, sourceId: string) =>
    storage.engine().query(
      `INSERT INTO timeline_events
         (slug, occurred_at, event, detail, source_label, source_chunk_id, source_id)
       VALUES ($1, $2::timestamptz, $3, '', '', NULL, $4)`,
      [ENTITY_SLUG, occurredAt, event, sourceId],
    );
  await seedEvent("2026-01-01T00:00:00Z", A_EVENT, A);
  await seedEvent("2026-01-02T00:00:00Z", B_EVENT, B);

  // --- resolve_slugs: distinct slugs, SAME title -----------------------------
  await putPage(storage, { slug: "team-a/alice", type: "person", title: SHARED_TITLE, markdown_body: A_BODY, source_id: A });
  await putPage(storage, { slug: "team-b/alice", type: "person", title: SHARED_TITLE, markdown_body: B_BODY, source_id: B });

  // --- Shared graph start + per-source outbound edges ------------------------
  await putPage(storage, { slug: GATEWAY, type: "note", title: "Gateway", markdown_body: "g", source_id: A });
  await putPage(storage, { slug: "vault-a/target", type: "note", title: "Target A", markdown_body: "ta", source_id: A });
  await putPage(storage, { slug: "vault-b/target", type: "note", title: "Target B", markdown_body: "tb", source_id: B });
  await addLink(storage, { source_slug: GATEWAY, target_slug: "vault-a/target", type: "mentions", source_id: A });
  await addLink(storage, { source_slug: GATEWAY, target_slug: "vault-b/target", type: "mentions", source_id: B });
  // Per-tenant wikilink edges to the shared WIKI_NAME target (backlinks).
  await addLink(storage, { source_slug: "vault-a/target", target_slug: WIKI_NAME, type: "wikilink", source_id: A });
  await addLink(storage, { source_slug: "vault-b/target", target_slug: WIKI_NAME, type: "wikilink", source_id: B });

  // --- Degree hub per tenant (find_experts / find_anomalies / salience) ------
  for (const [hub, spokes, src] of [
    ["hub-a", ["spoke-a1", "spoke-a2", "spoke-a3"], A],
    ["hub-b", ["spoke-b1", "spoke-b2", "spoke-b3"], B],
  ] as const) {
    await putPage(storage, { slug: hub, type: "note", title: hub, markdown_body: "hub", source_id: src });
    for (const s of spokes) {
      await putPage(storage, { slug: s, type: "note", title: s, markdown_body: "spoke", source_id: src });
      await addLink(storage, { source_slug: s, target_slug: hub, type: "mentions", source_id: src });
    }
  }

  // --- contradicts edge per tenant (find_contradictions) --------------------
  for (const [a1, a2, src] of [
    ["claim-a1", "claim-a2", A],
    ["claim-b1", "claim-b2", B],
  ] as const) {
    await putPage(storage, { slug: a1, type: "note", title: a1, markdown_body: "c", source_id: src });
    await putPage(storage, { slug: a2, type: "note", title: a2, markdown_body: "c", source_id: src });
    await addLink(storage, { source_slug: a1, target_slug: a2, type: "contradicts", source_id: src, allowAdHocType: true });
  }

  // --- documents / chunks / mentions (code_* reads) -------------------------
  await seedDoc(DOC_A_NOTES, "/tenant-a/notes.md", "AAA Notes", A);
  await seedDoc(DOC_B_NOTES, "/tenant-b/notes.md", "BBB Notes", B);
  await seedChunk("ch-a-notes", DOC_A_NOTES, 0, `mentions [[${WIKI_NAME}]] ${A_BODY}`);
  await seedChunk("ch-b-notes", DOC_B_NOTES, 0, `mentions [[${WIKI_NAME}]] ${B_BODY}`);
  await seedMention("wikilink", WIKI_NAME, "ch-a-notes", WIKI_NAME);
  await seedMention("wikilink", WIKI_NAME, "ch-b-notes", WIKI_NAME);

  // Shared source_path + shared code symbol; distinctive callee/caller surfaces.
  await seedDoc(DOC_A_CODE, SHARED_PATH, "pay a", A);
  await seedDoc(DOC_B_CODE, SHARED_PATH, "pay b", B);
  await seedChunk("ch-a-pay", DOC_A_CODE, 0, `${CODE_SYM} calls ${A_CALLEE}`, 1, 5, CODE_SYM);
  await seedChunk("ch-b-pay", DOC_B_CODE, 0, `${CODE_SYM} calls ${B_CALLEE}`, 1, 5, CODE_SYM);
  await seedMention("code-def", CODE_SYM, "ch-a-pay", CODE_SYM);
  await seedMention("code-def", CODE_SYM, "ch-b-pay", CODE_SYM);
  await seedMention("code-ref", CODE_SYM, "ch-a-pay", CODE_SYM);
  await seedMention("code-ref", CODE_SYM, "ch-b-pay", CODE_SYM);
  await seedMention("code-caller", CODE_SYM, "ch-a-pay", A_CALLER);
  await seedMention("code-caller", CODE_SYM, "ch-b-pay", B_CALLER);
  await seedMention("code-callee", CODE_SYM, "ch-a-pay", A_CALLEE);
  await seedMention("code-callee", CODE_SYM, "ch-b-pay", B_CALLEE);

  // code_edges_symbol for the recursive walks (code_blast / code_flow).
  await seedCodeEdge("ch-a-pay", CODE_SYM, A_CALLEE, A); // flow a
  await seedCodeEdge("ch-b-pay", CODE_SYM, B_CALLEE, B); // flow b
  await seedCodeEdge("ch-a-pay", A_CALLER, CODE_SYM, A); // blast a
  await seedCodeEdge("ch-b-pay", B_CALLER, CODE_SYM, B); // blast b

  // --- synth_takes (list_takes) — scoped via source_ref → documents.source_id ---
  // Fixed, distinct generation times: two inserts in a row can share a
  // timestamp, which would make the default newest-first listing order vary.
  for (const [key, ref, claim, generatedAt] of [
    ["take-a", DOC_A_NOTES, A_TAKE, "2026-01-01T00:00:00Z"],
    ["take-b", DOC_B_NOTES, B_TAKE, "2026-01-02T00:00:00Z"],
  ] as const) {
    await storage.engine().query(
      `INSERT INTO synth_takes
         (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, domain, status, model_id, generated_at)
       VALUES ($1, $2, 'h', 'v1', $3, 'judgment', 0.5, NULL, 'queued', 'test', $4::timestamptz)`,
      [key, ref, claim, generatedAt],
    );
  }

  // --- synth_concepts (list_concepts) — GLOBAL aggregate, no source axis -----
  for (const [slug, narrative] of [
    ["concept-aaa", "AAA_CONCEPT_narrative"],
    ["concept-bbb", "BBB_CONCEPT_narrative"],
  ] as const) {
    await storage.engine().query(
      `INSERT INTO synth_concepts (concept_slug, title, narrative, tier, atom_count, model_id)
       VALUES ($1, $1, $2, 'T3', 1, 'test')`,
      [slug, narrative],
    );
  }

  // --- search store (search tool) — shared keyword, per-tenant secret tokens --
  await indexPageIntoSearch(storage, { slug: "search-a/kanga", title: "Kanga A", markdown_body: `${KEYWORD} ${A_SEARCH}`, source_id: A }, { embedFn });
  await indexPageIntoSearch(storage, { slug: "search-b/kanga", title: "Kanga B", markdown_body: `${KEYWORD} ${B_SEARCH}`, source_id: B }, { embedFn });
  return { factIdA: fa.id as number, factIdB: fb.id as number };
}
