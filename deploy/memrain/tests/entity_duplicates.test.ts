/**
 * Duplicate people and companies: the key-based finder, its classes, crowded
 * and role values, persistent rejections and the confirm path into
 * entity-merge.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { findDuplicateGroups, readRejections, scanEntityPages, type DuplicateResult } from "../src/core/entity-duplicates.ts";
import { confirmDuplicatePair, rejectDuplicatePair, renderPreview } from "../src/commands/dedupe.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-dedupe-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function person(slug: string, title: string, truth: Record<string, unknown>, sourceId = "default"): Promise<void> {
  await putPage(storage, { slug, type: "person", title, compiled_truth: truth, markdown_body: `${title}.`, source_id: sourceId });
}

async function company(slug: string, title: string, truth: Record<string, unknown>): Promise<void> {
  await putPage(storage, { slug, type: "company", title, compiled_truth: truth, markdown_body: `${title}.` });
}

async function preview(): Promise<DuplicateResult> {
  const engine = storage.engine();
  return findDuplicateGroups(await scanEntityPages(engine), await readRejections(engine));
}

function classes(result: DuplicateResult): Array<[string, string[]]> {
  return result.groups.map((g) => [g.class, g.members]);
}

describe("duplicate finder", () => {
  // Value: protects=a shared LinkedIn with one name is the strongest hint; fails_when=the clean rule loosens or tightens.
  it("calls a shared LinkedIn with the same name clean", async () => {
    await person("people/alice-example", "Alice Example", { linkedin: "https://www.linkedin.com/in/alice-example/" });
    await person("people/alice", "Alice Example", { linkedin: "alice-example" });
    expect(classes(await preview())).toEqual([["clean", ["people/alice", "people/alice-example"]]]);
  });

  it("calls a shared email only likely, and never shows key values", async () => {
    await person("people/bob-a", "Bob Example", { email: "Bob@Example.org" });
    await person("people/bob-b", "Bob Example", { emails: ["bob@example.org"] });
    const result = await preview();
    expect(classes(result)).toEqual([["likely", ["people/bob-a", "people/bob-b"]]]);
    expect(JSON.stringify(result)).not.toContain("bob@example.org");
    expect(renderPreview(result)).not.toContain("example.org");
  });

  it("calls one LinkedIn under two names a conflict", async () => {
    await person("people/carol", "Carol Example", { linkedin: "in/carol-x" });
    await person("people/dave", "Dave Sample", { linkedin: "in/carol-x" });
    expect(classes(await preview())).toEqual([["conflict", ["people/carol", "people/dave"]]]);
  });

  it("vetoes a shared email when the LinkedIn ids differ", async () => {
    await person("people/erin-a", "Erin Example", { email: "erin@example.org", linkedin: "in/erin-a" });
    await person("people/erin-b", "Erin Example", { email: "erin@example.org", linkedin: "in/erin-b" });
    const [group] = (await preview()).groups;
    expect(group!.class).toBe("conflict");
    expect(group!.evidence).toContainEqual(expect.objectContaining({ rule: "key_differs", key: "linkedin", veto: true }));
  });

  it("never calls two companies with different domains clean", async () => {
    await company("companies/acme", "Acme", { linkedin: "company/acme", domain: "acme.com" });
    await company("companies/acme-uk", "Acme", { linkedin: "https://linkedin.com/company/acme", website: "https://acme.co.uk/" });
    expect(classes(await preview())).toEqual([["likely", ["companies/acme", "companies/acme-uk"]]]);
  });

  it("ignores a value more than five pages carry, a role mailbox and a free-mail domain", async () => {
    for (let i = 0; i < 6; i++) await person(`people/p${i}`, `Person ${i}`, { phone: "+1 555 000 1111" });
    await person("people/x1", "Xavier Example", { email: "info@example.org" });
    await person("people/x2", "Xavier Example", { email: "info@example.org" });
    await company("companies/one", "One", { domain: "gmail.com" });
    await company("companies/two", "Two", { domain: "gmail.com" });
    const result = await preview();
    expect(result.groups).toEqual([]);
    expect(result.counts.crowded_key_values).toBe(1);
  });

  it("never groups pages across sources", async () => {
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('work', 'other', 'work/') ON CONFLICT DO NOTHING`);
    await person("people/fay", "Fay Example", { github: "fay-x" });
    await person("people/fay-work", "Fay Example", { github: "fay-x" }, "work");
    expect((await preview()).groups).toEqual([]);
  });

  // Value: protects=a title word, a deleted-user login or a placeholder handle never decides a group; fails_when=the word lists shrink back.
  it("reads a role before a name as a title, and ghost or a placeholder handle as no key", async () => {
    await person("people/jane-a", "CEO Jane Example", { email: "jane@example.org" });
    await person("people/jane-b", "Jane Example", { email: "jane@example.org" });
    await person("people/ghost-a", "Pat Example", { github: "ghost", x_handle: "private" });
    await person("people/ghost-b", "Quinn Sample", { github: "ghost", x_handle: "private" });
    expect(classes(await preview())).toEqual([["likely", ["people/jane-a", "people/jane-b"]]]);
  });

  it("reads an organization page as a company", async () => {
    await company("companies/acme", "Acme Labs", { domain: "acme-example.org" });
    await putPage(storage, { slug: "orgs/acme", type: "organization", allowAdHocType: true, title: "Acme", compiled_truth: { website: "https://acme-example.org" }, markdown_body: "Acme." });
    expect(classes(await preview())).toEqual([["likely", ["companies/acme", "orgs/acme"]]]);
  });

  it("reads a declared id field the operator names", async () => {
    await company("companies/g1", "Globex", { registry_no: "12345" });
    await company("companies/g2", "Globex", { registry_no: "12345" });
    const engine = storage.engine();
    expect(findDuplicateGroups(await scanEntityPages(engine)).groups).toEqual([]);
    const named = findDuplicateGroups(await scanEntityPages(engine, { idFields: ["registry_no"] }));
    expect(named.groups.map((g) => g.class)).toEqual(["clean"]);
  });
});

describe("dedupe reject and confirm", () => {
  // Value: protects=a rejected pair stays out of every later preview; fails_when=rejections are not persisted or not read.
  it("keeps a rejected pair out of the preview, also after a rename", async () => {
    await person("people/gil-a", "Gil Example", { github: "gil-x" });
    await person("people/gil-b", "Gil Example", { github: "gil-x" });
    expect(await rejectDuplicatePair(storage, "default", "people/gil-b", "people/gil-a")).toEqual({ ok: true });
    expect((await preview()).groups).toEqual([]);
    // Same entity data on a new slug: the fingerprints still match.
    await storage.engine().query(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/gil-b'`);
    await person("people/gil-c", "Gil Example", { github: "gil-x" });
    expect((await preview()).groups).toEqual([]);
  });

  // Value: protects=a pair the page itself declares apart is never proposed or merged; fails_when=distinct_from is not read.
  it("keeps a pair one page declares distinct_from out of the preview", async () => {
    await person("people/max-a", "Max Example", { github: "max-x", distinct_from: ["people/max-b"] });
    await person("people/max-b", "Max Example", { github: "max-x" });
    expect((await preview()).groups).toEqual([]);
  });

  it("judges the other pairs of a group that holds a rejected pair", async () => {
    for (const slug of ["people/lu-a", "people/lu-b", "people/lu-c"]) await person(slug, "Lu Example", { email: "lu@example.org" });
    await rejectDuplicatePair(storage, "default", "people/lu-a", "people/lu-b");
    expect(classes(await preview()).map(([, m]) => m).sort()).toEqual([["people/lu-a", "people/lu-c"], ["people/lu-b", "people/lu-c"]]);
  });

  it("keeps a rejection to its own source", async () => {
    await storage.engine().query(`INSERT INTO sources (id, kind, path_prefix) VALUES ('work', 'other', 'work/') ON CONFLICT DO NOTHING`);
    await person("people/mo-a", "Mo Example", { github: "mo" });
    await person("people/mo-b", "Mo Example", { github: "mo" });
    await person("people/mo-c", "Mo Example", { github: "mo" }, "work");
    await person("people/mo-d", "Mo Example", { github: "mo" }, "work");
    await rejectDuplicatePair(storage, "default", "people/mo-a", "people/mo-b");
    expect((await preview()).groups.map((g) => g.source_id)).toEqual(["work"]);
  });

  it("merges a confirmed pair with entity-merge", async () => {
    await person("people/hal", "Hal Example", { linkedin: "in/hal" });
    await person("people/hal-example", "Hal Example", { linkedin: "in/hal" });
    const [group] = (await preview()).groups;
    expect(await confirmDuplicatePair(storage, "default", "people/hal", "people/hal-example", [], "")).toMatchObject({ ok: false });
    const out = await confirmDuplicatePair(storage, "default", "people/hal", "people/hal-example", [], group!.id);
    expect(out.ok).toBe(true);
    expect(await getPage(storage, "people/hal-example", ["default"])).not.toBeNull();
    const stub = await storage.engine().query<{ deleted: boolean }>(`SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE slug = 'people/hal'`);
    expect(stub.rows[0]!.deleted).toBe(true);
  });

  // Value: protects=a veto from a custom id field the preview read cannot vanish at confirm; fails_when=confirm re-reads with fewer id fields.
  it("refuses a confirm that reads other id fields than the preview", async () => {
    await company("companies/n1", "Nimbus", { email: "hello@nimbus.example", registry_no: "111" });
    await company("companies/n2", "Nimbus", { email: "hello@nimbus.example", registry_no: "222" });
    const engine = storage.engine();
    const vetoed = findDuplicateGroups(await scanEntityPages(engine, { idFields: ["registry_no"] }), []);
    expect(vetoed.groups.map((g) => g.class)).toEqual(["conflict"]);
    const id = vetoed.groups[0]!.id;
    expect(await confirmDuplicatePair(storage, "default", "companies/n1", "companies/n2", [], id)).toMatchObject({ ok: false });
    expect(await confirmDuplicatePair(storage, "default", "companies/n1", "companies/n2", ["registry_no"], id)).toMatchObject({ ok: false });
    const live = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'company' AND deleted_at IS NULL`);
    expect(live.rows[0]!.n).toBe(2);
  });

  it("refuses to merge a conflict, a pair with no shared key, or a rejected pair", async () => {
    await person("people/ivy", "Ivy Example", { linkedin: "in/ivy" });
    await person("people/ian", "Ian Sample", { linkedin: "in/ivy" });
    await person("people/jo", "Jo Example", {});
    await person("people/kim-a", "Kim Example", { github: "kim" });
    await person("people/kim-b", "Kim Example", { github: "kim" });
    await rejectDuplicatePair(storage, "default", "people/kim-a", "people/kim-b");
    const conflict = (await preview()).groups.find((g) => g.members.includes("people/ivy"))!;
    expect(conflict.class).toBe("conflict");
    for (const [a, b] of [["people/ivy", "people/ian"], ["people/ivy", "people/jo"], ["people/kim-a", "people/kim-b"]] as const) {
      const out = await confirmDuplicatePair(storage, "default", a, b, [], conflict.id);
      expect(out.ok).toBe(false);
    }
    const live = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'person' AND deleted_at IS NULL`);
    expect(live.rows[0]!.n).toBe(5);
  });
});
