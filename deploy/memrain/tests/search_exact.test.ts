import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage, deletePage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool, type DispatchOptions } from "../src/mcp/dispatch.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`literal page search (${name})`, () => {
  let db: Awaited<ReturnType<typeof open>>;
  const authInfo = { token: "test", clientId: "test", scopes: ["read"], sourceId: "default", allowedSources: ["default"], isPublic: false };
  beforeAll(async () => {
    db = await open();
    await registerSource(db.storage.engine(), { id: "exact-other", kind: "vault", pathPrefix: "/exact-other" });
    for (const [slug, type, body] of [
      ["notes/a", "note", "Literal INV-2024-0042 costs 50%_\\ exactly. Ёж"],
      ["notes/b", "note", "Another inv-2024-0042"], ["people/c", "person", "Unrelated body"],
      ["notes/deleted", "note", "INV-2024-0042"], ["notes/quarantined", "note", "INV-2024-0042"],
      ["notes/journal", "journal", "INV-2024-0042"], ["life/diary/day", "diary", "INV-2024-0042"],
    ]) await putPage(db.storage, { slug: slug!, type: type!, markdown_body: body!,
      ...(slug === "people/c" ? { compiled_truth: { invoice: "INV-2024-0042" } } : {}),
    });
    await putPage(db.storage, { slug: "foreign/invoice", markdown_body: "INV-2024-0042", source_id: "exact-other" });
    await deletePage(db.storage, "notes/deleted");
    await db.storage.engine().query(`INSERT INTO documents (id, source_path, source_id, frontmatter)
      VALUES ('exact-quarantine', 'page://notes/quarantined', 'default', '{"quarantine":{"reason":"test"}}'::jsonb)`);
  });
  afterAll(async () => { await db.close(); });
  const search = async (phrase: string, args: Record<string, unknown> = {}, opts: DispatchOptions = { authInfo }) => {
    const result = await dispatchTool(db.storage, { name: "search_exact", arguments: { phrase, ...args } }, opts);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };

  it("finds literal body and truth matches and truthfully reports completeness", async () => {
    const result = await search("INV-2024-0042");
    expect(result.hits.map((h: { slug: string }) => h.slug)).toEqual(["notes/a", "notes/b", "people/c"]);
    expect(result).toMatchObject({ scanned: 3, complete: true });
    expect(result.hits[2].snippet).toContain("INV-2024-0042");
    const limited = await search("INV-2024-0042", { limit: 2 });
    expect(limited).toMatchObject({ scanned: 3, complete: false });
    expect(limited.hits).toHaveLength(2);
    expect((await search("missing")).complete).toBe(true);
  });

  it("treats SQL metacharacters and Unicode literally and applies case/prefix/type filters", async () => {
    expect((await search("50%_\\")).hits.map((h: { slug: string }) => h.slug)).toEqual(["notes/a"]);
    expect((await search("Ёж", { case_sensitive: true })).hits).toHaveLength(1);
    expect((await search("ёж", { case_sensitive: true })).hits).toHaveLength(0);
    expect((await search("INV-2024-0042", { case_sensitive: true })).hits.map((h: { slug: string }) => h.slug)).toEqual(["notes/a", "people/c"]);
    expect((await search("INV-2024-0042", { slug_prefix: "notes/", type: "note" })).scanned).toBe(2);
    expect((await search("INV-2024-0042", { type: "person" })).hits.map((h: { slug: string }) => h.slug)).toEqual(["people/c"]);
    expect((await search("' OR TRUE --")).hits).toEqual([]);
  });

  it("keeps empty grants empty and rejects invalid inputs without exposing public bodies", async () => {
    const previous = process.env.MEMRAIN_TENANT_FAIL_CLOSED;
    process.env.MEMRAIN_TENANT_FAIL_CLOSED = "1";
    try {
      const empty = await search("INV-2024-0042", {}, { authInfo: { ...authInfo, sourceId: undefined, allowedSources: [] } });
      expect(empty).toMatchObject({ hits: [], scanned: 0, complete: true });
    } finally {
      if (previous === undefined) delete process.env.MEMRAIN_TENANT_FAIL_CLOSED;
      else process.env.MEMRAIN_TENANT_FAIL_CLOSED = previous;
    }
    for (const args of [{ phrase: "" }, { phrase: "x".repeat(501) }, { limit: 201 }, { slug_prefix: "../" }]) {
      const result = await dispatchTool(db.storage, { name: "search_exact", arguments: { phrase: "invoice", ...args } }, { authInfo });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error).toBe("invalid_params");
    }
    expect(isPublicMcpToolForbidden("search_exact")).toBe(true);
    const publicResult = await dispatchTool(db.storage, { name: "search_exact", arguments: { phrase: "INV-2024-0042" } }, { authInfo, isPublic: true });
    expect(publicResult.content[0]!.text).not.toContain("Literal INV");
  });

  it("bounds the snippet around a late match and scans stored secret text on output", async () => {
    await putPage(db.storage, { slug: "notes/long", markdown_body: "a".repeat(9000) + " needle-at-end " + "b".repeat(9000) });
    const hit = (await search("needle-at-end")).hits[0];
    expect(hit.snippet.length).toBeLessThanOrEqual(400);
    expect(hit.snippet).toContain("needle-at-end");
    const token = `gh${"p"}_${"x".repeat(36)}`;
    await db.storage.engine().query("UPDATE pages SET markdown_body = $1 WHERE slug = 'notes/long'", [`needle-at-end ${token}`]);
    const redacted = await search("needle-at-end");
    expect(redacted.hits[0].snippet).toContain("[REDACTED:");
    expect(JSON.stringify(redacted)).not.toContain(token);
  });

  if (name === "Postgres") it("reports an interrupted scan as incomplete and releases its transaction", async () => {
    let acquired!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const holder = db.storage.engine().transaction(async tx => {
      await tx.exec("LOCK TABLE pages IN ACCESS EXCLUSIVE MODE");
      acquired();
      await unlocked;
    });
    await ready;
    try {
      expect(await search("INV-2024-0042")).toMatchObject({ hits: [], scanned: null, complete: false, reason: "timeout" });
    } finally { release(); await holder; }
    expect((await search("INV-2024-0042")).hits).toHaveLength(3);
  }, 10_000);
});
