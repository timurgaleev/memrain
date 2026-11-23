/**
 * Tenant WRITE-path isolation — the destructive-op leak contract.
 *
 * READ isolation (v1.58) proved a scoped caller never SEES another tenant's
 * rows. This suite proves the symmetric write contract: a caller scoped to one
 * write source can never DELETE / REVERT / UNLINK / REMOVE-TAG / FORGET / PURGE
 * a row owned by another source — the destructive mutation matches ZERO rows
 * (a no-op), while a same-scope op affects its own, and an UNSCOPED op (the
 * local CLI / internal path) still affects the row exactly as today.
 *
 * The write scope is the caller's SINGLE write source (a scalar), NOT the
 * federated READ set: a tenant may read many sources but must only mutate
 * within its own write source.
 *
 * Bedrock-free: seeds via core writers, asserts through the core fns + a
 * dispatch end-to-end. Single shared Storage (beforeAll), per-test unique slugs
 * so tests never share mutable state. The global `pages.slug` PK still blocks
 * two same-slug ROWS, so pages use distinct per-tenant slugs (the by-slug
 * cross-tenant call is the attack); tags/links prove the scope filter on
 * a row that DOES exist under the other source.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import {
  putPage,
  getPage,
  deletePage,
  restorePage,
  revertPage,
} from "../src/core/pages.ts";
import { addLink, removeLink } from "../src/core/links.ts";
import { addTag, getTags, removeTag } from "../src/core/tags.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexDocument } from "../src/core/indexer.ts";
import * as embedding from "../src/core/embedding.ts";
import { writeDocumentTransaction } from "../src/core/indexer-tx.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

const A = "tenanta";
const B = "tenantb";

let tmp: string;
let storage: Storage;

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

async function linkCount(source_slug: string, target_slug: string, type: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM links
      WHERE source_slug = $1 AND target_slug = $2 AND type = $3`,
    [source_slug, target_slug, type],
  );
  return r.rows[0]?.n ?? 0;
}

async function pageRowCount(slug: string): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1`,
    [slug],
  );
  return r.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-write-iso-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: A, kind: "vault", pathPrefix: "/a" });
  await registerSource(e, { id: B, kind: "vault", pathPrefix: "/b" });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("deletePage write scope", () => {
  it("a delete scoped to A cannot soft-delete B's page (no-op)", async () => {
    const slug = "del/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    const r = await deletePage(storage, slug, undefined, A);
    expect(r.already_deleted).toBe(true); // out-of-scope → matched zero rows
    expect((await getPage(storage, slug, [B]))?.deleted_at).toBeNull(); // survives
  });

  it("a delete scoped to B soft-deletes B's own page", async () => {
    const slug = "del/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    const r = await deletePage(storage, slug, undefined, B);
    expect(r.already_deleted).toBe(false);
    expect(await getPage(storage, slug, [B])).toBeNull();
  });

  it("an UNSCOPED delete still soft-deletes the page (behavior-neutral)", async () => {
    const slug = "del/a-unscoped";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    expect((await deletePage(storage, slug)).already_deleted).toBe(false);
    expect(await getPage(storage, slug, [A])).toBeNull();
  });
});

describe("restorePage write scope", () => {
  it("a restore scoped to A cannot undelete B's page (no-op)", async () => {
    const slug = "rest/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug, undefined, A)).restored).toBe(false);
    expect(await getPage(storage, slug, [B])).toBeNull(); // still deleted
  });

  it("a restore scoped to B undeletes B's own page; unscoped works too", async () => {
    const slug = "rest/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug, undefined, B)).restored).toBe(true);
    expect(await getPage(storage, slug, [B])).not.toBeNull();
    // Behavior-neutral: unscoped restore on a re-deleted page still works.
    await deletePage(storage, slug, undefined, B);
    expect((await restorePage(storage, slug)).restored).toBe(true);
  });
});

describe("revertPage write scope", () => {
  it("a revert scoped to A cannot roll back B's page (page not found)", async () => {
    const slug = "rev/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "v1 quixor", source_id: B });
    await putPage(storage, { slug, type: "note", markdown_body: "v2 quixor", source_id: B });
    const r = await revertPage(storage, slug, 1, undefined, A);
    expect(r.reverted).toBe(false);
    expect(r.reason).toMatch(/not found/);
    expect((await getPage(storage, slug, [B]))?.markdown_body).toBe("v2 quixor"); // unchanged
  });

  it("a revert scoped to B rolls back B's own page; unscoped works too", async () => {
    const slug = "rev/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "v1 quixor", source_id: B });
    await putPage(storage, { slug, type: "note", markdown_body: "v2 quixor", source_id: B });
    expect((await revertPage(storage, slug, 1, undefined, B)).reverted).toBe(true);
    expect((await getPage(storage, slug, [B]))?.markdown_body).toBe("v1 quixor");
    // Behavior-neutral: an unscoped revert on a default page still works.
    const dslug = "rev/default";
    await putPage(storage, { slug: dslug, type: "note", markdown_body: "d1" });
    await putPage(storage, { slug: dslug, type: "note", markdown_body: "d2" });
    expect((await revertPage(storage, dslug, 1)).reverted).toBe(true);
  });
});

describe("removeLink write scope", () => {
  it("an unlink scoped to A cannot remove B's edge (0 removed)", async () => {
    const slug = "link/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    const r = await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: A });
    expect(r.removed).toBe(0);
    expect(await linkCount(slug, "companies/acme", "mentions")).toBe(1); // survives
  });

  it("an unlink scoped to B removes B's own edge; unscoped removes too", async () => {
    const slug = "link/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    expect((await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B })).removed).toBe(1);
    expect(await linkCount(slug, "companies/acme", "mentions")).toBe(0);
    // Behavior-neutral: an unscoped unlink still removes a matching edge.
    await addLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions", source_id: B });
    expect((await removeLink(storage, { source_slug: slug, target_slug: "companies/acme", type: "mentions" })).removed).toBe(1);
  });
});

describe("removeTag write scope", () => {
  it("a remove_tag scoped to A cannot unset B's tag (survives)", async () => {
    const slug = "tag/b-guard";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addTag(storage, slug, "btag", B);
    await removeTag(storage, slug, "btag", A);
    expect(await getTags(storage, slug, [B])).toContain("btag"); // survives
  });

  it("a remove_tag scoped to B unsets B's own tag; unscoped works too", async () => {
    const slug = "tag/b-own";
    await putPage(storage, { slug, type: "note", markdown_body: "b body", source_id: B });
    await addTag(storage, slug, "btag", B);
    await removeTag(storage, slug, "btag", B);
    expect(await getTags(storage, slug, [B])).not.toContain("btag");
    // Behavior-neutral: an unscoped remove_tag still unsets a tag.
    await addTag(storage, slug, "btag2", B);
    await removeTag(storage, slug, "btag2");
    expect(await getTags(storage, slug, [B])).not.toContain("btag2");
  });
});

describe("purgeDeletedPages write scope", () => {
  it("a purge scoped to A reaps only A's soft-deleted rows, never B's", async () => {
    const pa = "purge/a-row";
    const pb = "purge/b-row";
    await putPage(storage, { slug: pa, type: "note", markdown_body: "a", source_id: A });
    await putPage(storage, { slug: pb, type: "note", markdown_body: "b", source_id: B });
    await deletePage(storage, pa, undefined, A);
    await deletePage(storage, pb, undefined, B);
    const r = await purgeDeletedPages(storage.engine(), 0, [A]);
    expect(r.slugs).toContain(pa);
    expect(r.slugs).not.toContain(pb);
    expect(await pageRowCount(pa)).toBe(0); // A's row hard-deleted
    expect(await pageRowCount(pb)).toBe(1); // B's row survives
  });

  it("an UNSCOPED purge reaps every aged soft-deleted row (behavior-neutral)", async () => {
    const pb = "purge/b-unscoped";
    await putPage(storage, { slug: pb, type: "note", markdown_body: "b", source_id: B });
    await deletePage(storage, pb, undefined, B);
    const r = await purgeDeletedPages(storage.engine(), 0);
    expect(r.slugs).toContain(pb);
    expect(await pageRowCount(pb)).toBe(0);
  });
});

describe("dispatch end-to-end: writeSource threads from authInfo", () => {
  it("page_delete via a B-scoped bearer cannot delete A's page", async () => {
    const slug = "e2e/a-page";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    // B-scoped caller targeting A's slug → no-op (already_deleted).
    const res = await dispatchTool(storage, { name: "page_delete", arguments: { slug } }, { authInfo: auth(B) });
    expect(JSON.parse(res.content[0]!.text).already_deleted).toBe(true);
    expect((await getPage(storage, slug, [A]))?.deleted_at).toBeNull(); // survives
    // A-scoped caller deletes its own page.
    const res2 = await dispatchTool(storage, { name: "page_delete", arguments: { slug } }, { authInfo: auth(A) });
    expect(JSON.parse(res2.content[0]!.text).already_deleted).toBe(false);
  });

  it("remove_tag via a B-scoped bearer cannot unset A's tag", async () => {
    const slug = "e2e/a-tagged";
    await putPage(storage, { slug, type: "note", markdown_body: "a body", source_id: A });
    await addTag(storage, slug, "atag", A);
    await dispatchTool(storage, { name: "remove_tag", arguments: { slug, tag: "atag" } }, { authInfo: auth(B) });
    expect(await getTags(storage, slug, [A])).toContain("atag"); // survives
  });
});

describe("index (writeDocumentTransaction) write scope", () => {
  // Regression: `documents.id` hashes only the caller-supplied source_path, and
  // those paths are predictable (`page://<source>/<slug>`). Before the fence, a
  // caller scoped to B could name A's path, land on A's row, and have its chunks
  // deleted and rewritten from B's text — A's canonical page survived, but A's
  // own search stopped finding it. Reproduced live against the pilot install
  // before the fix; these tests lock the fence in.
  const docFor = (sourcePath: string, sourceId: string | null, title: string) => ({
    documentId: `doc_${Buffer.from(sourcePath).toString("hex").slice(0, 16)}`,
    sourcePath,
    title,
    frontmatter: {},
    sourceId,
  });

  async function ownerOf(documentId: string): Promise<string | null> {
    const r = await storage.engine().query<{ source_id: string | null }>(
      "SELECT source_id FROM documents WHERE id = $1",
      [documentId],
    );
    return r.rows[0]?.source_id ?? null;
  }

  async function chunkTexts(documentId: string): Promise<string> {
    const r = await storage.engine().query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1",
      [documentId],
    );
    return r.rows.map((x) => x.content).join(" ");
  }

  it("a caller scoped to B cannot overwrite a document owned by A", async () => {
    const path = "page://tenanta/idx/victim";
    const victim = docFor(path, A, "A's doc");
    await writeDocumentTransaction(storage, victim, [{ text: "ALPHA secret numbers", entities: [] }]);
    expect(await ownerOf(victim.documentId)).toBe(A);

    // Same documentId — B named A's path, which is the whole attack.
    await expect(
      writeDocumentTransaction(storage, { ...victim, sourceId: B, title: "B's overwrite" }, [
        { text: "WIPED by B", entities: [] },
      ]),
    ).rejects.toThrow(/owned by another source/);

    expect(await ownerOf(victim.documentId)).toBe(A);
    expect(await chunkTexts(victim.documentId)).toContain("ALPHA");
  });

  it("a caller scoped to A can still re-index its OWN document", async () => {
    const own = docFor("page://tenanta/idx/own", A, "A's doc");
    await writeDocumentTransaction(storage, own, [{ text: "first revision", entities: [] }]);
    await writeDocumentTransaction(storage, { ...own, title: "A's doc v2" }, [
      { text: "second revision", entities: [] },
    ]);
    expect(await ownerOf(own.documentId)).toBe(A);
    expect(await chunkTexts(own.documentId)).toContain("second revision");
  });

  it("an UNSCOPED writer (local CLI reindex) still updates the row it owns", async () => {
    const seeded = docFor("page://tenanta/idx/cli", A, "A's doc");
    await writeDocumentTransaction(storage, seeded, [{ text: "seeded", entities: [] }]);
    // sourceId null → the COALESCE keeps A as owner and the write must land.
    await writeDocumentTransaction(
      storage,
      { ...seeded, sourceId: null, title: "reindexed by CLI" },
      [{ text: "reindexed", entities: [] }],
    );
    expect(await ownerOf(seeded.documentId)).toBe(A);
    expect(await chunkTexts(seeded.documentId)).toContain("reindexed");
  });
});

describe("an unowned document is not free real estate", () => {
  // The v1.124.0 fence refused a scoped caller only when the row already had a
  // NAMED owner. Every document the local sweeps write — vault, code, the
  // cycle — carries source_id NULL, so a tenant could name that document's
  // path, pass the fence, and have its chunks replaced with its own text. The
  // victim's page survives; their search stops finding it.
  const embedFn = (_t: string) => Promise.resolve(new Array(1024).fill(0.1));

  it("refuses a scoped caller that lands on a NULL-owned document", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "memrain-unowned-"));
    const s2 = new Storage({ dbPath: join(tmp2, "db") });
    try {
      await s2.init();
      await registerSource(s2.engine(), { id: "tenant", kind: "vault", pathPrefix: "/t" });

      // The operator's own local index pass: unscoped, so the row is unowned.
      await indexDocument(
        s2,
        { sourcePath: "vault/ops/runbook.md", text: "the operator's own runbook note" },
        { embedFn, inferFrontmatter: false },
      );
      const before = await s2.engine().query<{ source_id: string | null }>(
        `SELECT source_id FROM documents WHERE source_path = $1`,
        ["vault/ops/runbook.md"],
      );
      expect(before.rows[0]!.source_id).toBeNull();

      // A tenant naming that same path must be refused, not handed the row.
      await expect(indexDocument(
        s2,
        { sourcePath: "vault/ops/runbook.md", text: "attacker text", sourceId: "tenant" },
        { embedFn, inferFrontmatter: false },
      )).rejects.toThrow(/owned by another source/);

      const after = await s2.engine().query<{ source_id: string | null }>(
        `SELECT source_id FROM documents WHERE source_path = $1`,
        ["vault/ops/runbook.md"],
      );
      expect(after.rows[0]!.source_id).toBeNull();
      const chunk = await s2.engine().query<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE d.source_path = $1 LIMIT 1`,
        ["vault/ops/runbook.md"],
      );
      // The victim's chunks are intact — the takeover replaces them.
      expect(chunk.rows[0]!.content).toContain("operator");
    } finally {
      await s2.close();
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});

describe("an empty grant reads nothing in the search arms", () => {
  // `undefined` is the operator (whole brain); `[]` is a caller granted
  // nothing. `think` renders these arms straight into a synthesis prompt, so
  // an empty grant that silently widened returned another tenant's TEXT.
  const embedFn = (_t: string) => Promise.resolve(new Array(1024).fill(0.1));

  it("keyword arm: unscoped sees both, a grant sees one, an empty grant sees none", async () => {
    const tmp3 = mkdtempSync(join(tmpdir(), "memrain-empty-grant-"));
    const s3 = new Storage({ dbPath: join(tmp3, "db") });
    try {
      await s3.init();
      await registerSource(s3.engine(), { id: "alpha", kind: "vault", pathPrefix: "/alpha" });
      await registerSource(s3.engine(), { id: "beta", kind: "vault", pathPrefix: "/beta" });
      await indexDocument(
        s3,
        { sourcePath: "alpha/note.md", text: "quarterly zebra findings for alpha", sourceId: "alpha" },
        { embedFn, inferFrontmatter: false },
      );
      await indexDocument(
        s3,
        { sourcePath: "beta/note.md", text: "quarterly zebra findings for beta", sourceId: "beta" },
        { embedFn, inferFrontmatter: false },
      );
      const { keywordSearch } = await import("../src/core/search/keyword.ts");
      const e = s3.engine();

      expect((await keywordSearch(e, "zebra", 10, {})).length).toBe(2);
      expect((await keywordSearch(e, "zebra", 10, { sourceIds: ["alpha"] })).length).toBe(1);
      expect(await keywordSearch(e, "zebra", 10, { sourceIds: [] })).toEqual([]);
    } finally {
      await s3.close();
      rmSync(tmp3, { recursive: true, force: true });
    }
  });
});

describe("index `path` form is operator-only", () => {
  // The path form reads a server file through indexFile, which carries no write
  // source — a tenant reaching it would index daemon files into unowned rows.
  let root: string;
  const saved = {
    vault: process.env.MEMRAIN_VAULT_PATHS,
    code: process.env.MEMRAIN_CODE_PATHS,
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "memrain-index-path-"));
    writeFileSync(join(root, "server.md"), "a file on the daemon's disk");
    process.env.MEMRAIN_VAULT_PATHS = root;
    delete process.env.MEMRAIN_CODE_PATHS;
  });

  afterAll(() => {
    if (saved.vault === undefined) delete process.env.MEMRAIN_VAULT_PATHS;
    else process.env.MEMRAIN_VAULT_PATHS = saved.vault;
    if (saved.code === undefined) delete process.env.MEMRAIN_CODE_PATHS;
    else process.env.MEMRAIN_CODE_PATHS = saved.code;
    rmSync(root, { recursive: true, force: true });
  });

  async function documentCount(): Promise<number> {
    const r = await storage.engine().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM documents`,
    );
    return r.rows[0]?.n ?? 0;
  }

  it("refuses a tenant's path form inside an allowed root and writes nothing", async () => {
    const before = await documentCount();
    const res = await dispatchTool(
      storage,
      { name: "index", arguments: { path: join(root, "server.md") } },
      { authInfo: auth(A) },
    );
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/internal-only/);
    expect(await documentCount()).toBe(before);
  });

  it("the operator's path form still passes the gate and reaches the root guard", async () => {
    const res = await dispatchTool(
      storage,
      { name: "index", arguments: { path: join(tmp, "outside.md") } },
    );
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).not.toMatch(/internal-only/);
    expect(text).toMatch(/outside the configured/);
  });
});

describe("inline index strips gate-owned markers from every token holder", () => {
  it("a token with no write source cannot plant embed_skip", async () => {
    const embed = spyOn(embedding, "embedText").mockImplementation(async () => new Array(1024).fill(0.1));
    try {
      const unscoped: AuthInfo = {
        token: "tok-unscoped",
        clientId: "client-unscoped",
        scopes: ["read", "write"],
        isPublic: false,
      };
      const res = await dispatchTool(
        storage,
        {
          name: "index",
          arguments: { sourcePath: "notes/planted.md", text: "---\nembed_skip: true\n---\n\nkept out of the vector arm\n" },
        },
        { authInfo: unscoped },
      );
      expect(res.isError).toBeFalsy();
      const row = await storage.engine().query<{ frontmatter: Record<string, unknown> }>(
        "SELECT frontmatter FROM documents WHERE source_path = $1",
        ["notes/planted.md"],
      );
      expect(row.rows[0]!.frontmatter).not.toHaveProperty("embed_skip");
      expect(embed).toHaveBeenCalled();
    } finally {
      embed.mockRestore();
    }
  });
});
