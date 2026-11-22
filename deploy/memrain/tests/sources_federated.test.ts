/**
 * Federated sources: a read that names no source, from a caller whose grant
 * names none, reaches the default source plus the federated ones. A code
 * source starts unfederated, so its chunks stay out of ordinary search, and
 * an explicit source_ids, a grant that lists it, a code filter and the code
 * tools still reach it. Migration 195 keeps every existing non-code source
 * federated and runs twice without undoing a later choice.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import { federatedReadScope, getSource, registerSource, setSourceFederated } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { entityId } from "../src/core/entities.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = async (text: string) => deterministicEmbed(text);
const KEYWORD = "wombatfederation";
const SYMBOL = "federateWombat";
const NOTES = "notes-vault";
const CODE = "repo-code";

const MIGRATION_195 = readFileSync(join(import.meta.dir, "..", "src", "core", "migrations", "195_sources_federated.sql"), "utf8");

async function revertDownTo(e: Engine, id: number): Promise<void> {
  for (const later of discoverMigrations().map(m => m.id).filter(m => m >= id).sort((a, b) => b - a)) await revertMigration(e, later);
}

const flags = async (e: Engine) => Object.fromEntries((await e.query<{ id: string; federated: boolean }>(
  `SELECT id, federated FROM sources ORDER BY id`)).rows.map(r => [r.id, r.federated]));

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`federated sources (${engine.name})`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;

  const sourcesOf = async (name: string, args: Record<string, unknown>, authInfo?: AuthInfo) => {
    const r = await dispatchTool(db.storage, { name, arguments: args }, authInfo ? { authInfo } : {});
    const body = JSON.parse(r.content[0]!.text);
    expect(r.isError ?? false).toBe(false);
    return new Set((body.hits as Array<{ source_id?: string | null; sourcePath: string }>).map(h => h.source_id ?? h.sourcePath));
  };
  const key = (allowedSources?: string[]): AuthInfo => ({
    token: "t", clientId: "key", scopes: ["read"], isPublic: false, ...(allowedSources ? { allowedSources } : {}),
  });

  beforeAll(async () => {
    db = await engine.open();
    const e = db.storage.engine();
    await registerSource(e, { id: NOTES, kind: "vault", pathPrefix: "/fed-notes" });
    await registerSource(e, { id: CODE, kind: "code", pathPrefix: "/fed-code" });
    await indexPageIntoSearch(db.storage, { slug: "notes/wombat", title: "Wombat note", markdown_body: `${KEYWORD} in a note`, source_id: NOTES }, { embedFn });
    await indexPageIntoSearch(db.storage, { slug: "code/wombat", title: "Wombat code", markdown_body: `${KEYWORD} in code`, source_id: CODE }, { embedFn });
    // A code symbol definition the code tools look up, in the code source.
    await e.query(`INSERT INTO documents (id, source_path, title, source_id, frontmatter) VALUES ('fed-code-doc', '/fed-code/w.ts', 'w.ts', $1, '{"kind":"code","language":"typescript"}'::jsonb)`, [CODE]);
    await e.query(`INSERT INTO chunks (id, document_id, chunk_index, content, start_line, end_line, symbol_name_qualified, source_id, language)
                   VALUES ('fed-code-chunk', 'fed-code-doc', 0, $1, 1, 3, $2, $3, 'typescript')`, [`function ${SYMBOL}() {}`, SYMBOL, CODE]);
    await e.query(`INSERT INTO entities (id, type, name) VALUES ($1, 'code-def', $2) ON CONFLICT (id) DO NOTHING`, [entityId("code-def", SYMBOL), SYMBOL]);
    await e.query(`INSERT INTO entity_mentions (chunk_id, entity_id, surface_form) VALUES ('fed-code-chunk', $1, $2)`, [entityId("code-def", SYMBOL), SYMBOL]);
  });
  afterAll(async () => { await db.close(); });

  // Value: protects=registerSource's default (code unfederated, other kinds federated) and that a re-register keeps a
  // later choice; fails_when=a new code source joins unscoped reads or re-registering resets federation.
  it("registers a code source unfederated and every other kind federated", async () => {
    const e = db.storage.engine();
    expect((await getSource(e, CODE))?.federated).toBe(false);
    expect((await getSource(e, NOTES))?.federated).toBe(true);
    expect((await getSource(e, "default"))?.federated).toBe(true);
    await setSourceFederated(e, NOTES, false);
    await registerSource(e, { id: NOTES, kind: "vault", pathPrefix: "/fed-notes" });
    expect((await getSource(e, NOTES))?.federated).toBe(false);
    await setSourceFederated(e, NOTES, true);
    expect(await federatedReadScope(e, undefined)).toEqual(["default", NOTES]);
  });

  // Value: protects=the federated rule on unqualified reads; fails_when=an unscoped operator or unscoped key search
  // returns a chunk from an unfederated code source, or the note it should find goes missing.
  it("keeps an unfederated code source out of an unscoped search", async () => {
    expect(await sourcesOf("search", { q: KEYWORD })).toEqual(new Set([NOTES]));
    expect(await sourcesOf("query", { q: KEYWORD })).toEqual(new Set([NOTES]));
    expect(await sourcesOf("search", { q: KEYWORD }, key())).toEqual(new Set([NOTES]));
  });

  // Value: protects=the explicit routes past federation; fails_when=source_ids, a grant listing the source, or a code
  // filter stops reaching a code source.
  it("reaches the code source by source_ids, by a grant that lists it, and by a code filter", async () => {
    expect(await sourcesOf("search", { q: KEYWORD, source_ids: [NOTES, CODE] })).toEqual(new Set([NOTES, CODE]));
    expect(await sourcesOf("search", { q: KEYWORD }, key([NOTES, CODE]))).toEqual(new Set([NOTES, CODE]));
    expect(await sourcesOf("search", { q: KEYWORD, source_ids: [CODE] }, key())).toEqual(new Set([CODE]));
    expect(await sourcesOf("search", { q: SYMBOL, lang: "typescript" })).toContain(CODE);
  });

  // Value: protects=federation never widening a narrower read and never dropping a query refine's scope;
  // fails_when=a query with refine and a code filter searches every source, the owner-only narrowing order lets an
  // unbound key read the code source or an owner-only source, or a fail-closed empty grant reads anything.
  it("keeps refine, owner-only and fail-closed scopes at least as narrow", async () => {
    const e = db.storage.engine();
    expect(await sourcesOf("query", { q: KEYWORD, refine: "note", lang: "typescript" })).not.toContain(CODE);
    await registerSource(e, { id: "private-mail", kind: "mailbox", pathPrefix: "mail:fed" });
    await e.query(`UPDATE sources SET owner_only = true WHERE id = 'private-mail'`);
    await indexPageIntoSearch(db.storage, { slug: "mail/wombat", title: "Wombat mail", markdown_body: `${KEYWORD} in mail`, source_id: "private-mail" }, { embedFn });
    try {
      expect(await sourcesOf("search", { q: KEYWORD })).toEqual(new Set([NOTES, "private-mail"]));
      expect(await sourcesOf("search", { q: KEYWORD }, key())).toEqual(new Set([NOTES]));
      const prior = process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
      process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = "1";
      try {
        expect(await sourcesOf("search", { q: KEYWORD }, key())).toEqual(new Set());
      } finally {
        if (prior === undefined) delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
        else process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = prior;
      }
    } finally {
      await e.query(`DELETE FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE source_id = 'private-mail')`);
      await e.query(`DELETE FROM documents WHERE source_id = 'private-mail'`);
      await e.query(`DELETE FROM page_versions WHERE source_id = 'private-mail'`);
      await e.query(`DELETE FROM pages WHERE source_id = 'private-mail'`);
      await e.query(`DELETE FROM sources WHERE id = 'private-mail'`);
    }
  });

  // Value: protects=code tools reading unfederated sources; fails_when=code_def is scoped by federation.
  it("leaves the code tools reading every source", async () => {
    const r = await dispatchTool(db.storage, { name: "code_def", arguments: { name: SYMBOL } });
    expect(r.isError ?? false).toBe(false);
    expect(r.content[0]!.text).toContain("/fed-code/w.ts");
  });

  // Value: protects=federate/unfederate taking effect on the next read; fails_when=the flag is cached or ignored.
  it("follows federate and unfederate", async () => {
    const e = db.storage.engine();
    await setSourceFederated(e, CODE, true);
    expect(await sourcesOf("search", { q: KEYWORD })).toEqual(new Set([NOTES, CODE]));
    expect(await federatedReadScope(e, undefined)).toBeUndefined();
    await setSourceFederated(e, CODE, false);
    expect(await sourcesOf("search", { q: KEYWORD })).toEqual(new Set([NOTES]));
  });

  // Value: protects=migration 195 keeping existing non-code sources readable, unfederating code sources, re-running
  // without undoing a later choice, and reverting; fails_when=a note source loses unscoped reads, a code source keeps
  // them, a second run resets a flag, or the down file fails.
  it("migration 195 federates existing non-code sources, is idempotent, and reverts", async () => {
    const e = db.storage.engine();
    await revertDownTo(e, 195);
    expect((await e.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'sources' AND column_name = 'federated'`)).rows).toEqual([]);
    await e.query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('repo-source-code', 'other', '/repo-source/')`);
    expect((await runMigrations(e)).applied.map(m => m.id)).toContain(195);
    expect(await flags(e)).toEqual({ default: true, [NOTES]: true, [CODE]: false, "repo-source-code": false });
    expect(await sourcesOf("search", { q: KEYWORD })).toEqual(new Set([NOTES]));

    await setSourceFederated(e, CODE, true);
    await e.exec(MIGRATION_195);
    expect((await runMigrations(e)).applied).toEqual([]);
    expect((await flags(e))[CODE]).toBe(true);
    await setSourceFederated(e, CODE, false);

    await revertMigration(e, 195);
    await runMigrations(e);
    expect(await flags(e)).toEqual({ default: true, [NOTES]: true, [CODE]: false, "repo-source-code": false });
  });
});
