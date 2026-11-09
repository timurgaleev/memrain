import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, pageVersions, putPage, revertPage } from "../src/core/pages.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`page write reasons ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  beforeAll(async () => { db = await engine.open(); });
  afterAll(async () => { await db.close(); });
  it("records supplied reasons on actual put/edit/revert/delete versions without changing snapshots", async () => {
    const first = await putPage(db.storage, { slug: "notes/reasons", markdown_body: "Body A", change_reason: " initial " });
    await putPage(db.storage, { slug: "notes/reasons", edits: [{ old_text: "Body A", new_text: "Body B" }], expectedVersion: 1, change_reason: "correct figure" });
    await revertPage(db.storage, "notes/reasons", 1, undefined, undefined, { expectedVersion: 2, changeReason: "restore citation" });
    await deletePage(db.storage, "notes/reasons", undefined, undefined, { expectedVersion: 3, changeReason: "withdraw note" });
    const versions = (await pageVersions(db.storage, "notes/reasons")).reverse();
    expect(versions.map(row => row.change_reason)).toEqual(["initial", "correct figure", "restore citation", "withdraw note"]);
    expect(versions.map(row => row.body_snapshot)).toEqual(["Body A", "Body B", "Body A", ""]);
    expect(versions[2]!.hash_new).toBe(first.content_hash);
    const metadata = await pageVersions(db.storage, "notes/reasons", 20, undefined, { includeBody: false });
    expect(metadata[0]!.change_reason).toBe("withdraw note");
    expect(metadata[0]).not.toHaveProperty("body_snapshot");
  });
  it("does not create reason-only versions or copy historical reasons into a revert", async () => {
    await putPage(db.storage, { slug: "notes/reason-noop", markdown_body: "A", change_reason: "first" });
    expect((await putPage(db.storage, { slug: "notes/reason-noop", markdown_body: "A", change_reason: "ignored" })).changed).toBe(false);
    await putPage(db.storage, { slug: "notes/reason-noop", markdown_body: "B" });
    await revertPage(db.storage, "notes/reason-noop", 1);
    expect((await pageVersions(db.storage, "notes/reason-noop")).map(row => row.change_reason)).toEqual([null, null, "first"]);
    await deletePage(db.storage, "notes/reason-noop", undefined, undefined, { changeReason: "deleted" });
    expect((await deletePage(db.storage, "notes/reason-noop", undefined, undefined, { changeReason: "ignored" })).already_deleted).toBe(true);
    expect(await pageVersions(db.storage, "notes/reason-noop")).toHaveLength(4);
  });
  it("validates reason before mutation and counts Unicode code points", async () => {
    await putPage(db.storage, { slug: "notes/reason-validation", markdown_body: "original" });
    const before = await pageVersions(db.storage, "notes/reason-validation");
    for (const change_reason of ["bad\nreason", "bad\rreason", "bad\u2028reason", "bad\u2029reason", "bad\0reason", "bad\uD800reason", "😀".repeat(501), 42 as unknown as string]) {
      await expect(putPage(db.storage, { slug: "notes/reason-validation", markdown_body: "changed", change_reason })).rejects.toThrow("reason");
      await expect(deletePage(db.storage, "notes/reason-validation", undefined, undefined, { changeReason: change_reason })).rejects.toThrow("reason");
      await expect(revertPage(db.storage, "notes/reason-validation", 1, undefined, undefined, { changeReason: change_reason })).rejects.toThrow("reason");
    }
    expect(await pageVersions(db.storage, "notes/reason-validation")).toEqual(before);
    expect((await getPage(db.storage, "notes/reason-validation"))!.markdown_body).toBe("original");
    await putPage(db.storage, { slug: "notes/reason-emoji", markdown_body: "Emoji", change_reason: "😀".repeat(500) });
    expect((await pageVersions(db.storage, "notes/reason-emoji"))[0]!.change_reason).toBe("😀".repeat(500));
    await putPage(db.storage, { slug: "notes/reason-blank", markdown_body: "Blank", change_reason: " \t " });
    expect((await pageVersions(db.storage, "notes/reason-blank"))[0]!.change_reason).toBeNull();
  });
  it("shares secret echoes across reason, title, body and composed edits", async () => {
    const secret = "R7mdN2aQ8vLs5XcU1bZe4HjP9fWk6YtD";
    await putPage(db.storage, { slug: "notes/reason-secret", markdown_body: `Bare ${secret}`, title: secret, change_reason: `Authorization: Bearer ${secret}` });
    const all = JSON.stringify([await getPage(db.storage, "notes/reason-secret"), await pageVersions(db.storage, "notes/reason-secret")]);
    expect(all).not.toContain(secret);
    expect(all).toContain("REDACTED:bearer-token");
    await putPage(db.storage, { slug: "notes/reason-composed", markdown_body: "Authorization: Bea<tail>" });
    await putPage(db.storage, { slug: "notes/reason-composed", edits: [{ old_text: "<tail>", new_text: `rer ${secret}` }], change_reason: secret });
    expect(JSON.stringify(await pageVersions(db.storage, "notes/reason-composed"))).not.toContain(secret);
  });
  it("commits deletion metadata and its secret audit atomically", async () => {
    const e = db.storage.engine();
    await putPage(db.storage, { slug: "notes/reason-delete", markdown_body: "retain" });
    const secret = `${"gh"}p_${"Q7az".repeat(9)}`;
    await e.exec(`CREATE FUNCTION reject_reason_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.slug = 'notes/reason-delete' AND NEW.version_n > 1 THEN RAISE EXCEPTION 'fixture version failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_reason_version BEFORE INSERT ON page_versions FOR EACH ROW EXECUTE FUNCTION reject_reason_version()`);
    try {
      await expect(deletePage(db.storage, "notes/reason-delete", undefined, undefined, { changeReason: secret })).rejects.toThrow("fixture version failure");
      expect((await getPage(db.storage, "notes/reason-delete"))!.markdown_body).toBe("retain");
      expect(await pageVersions(db.storage, "notes/reason-delete")).toHaveLength(1);
      expect((await e.query("SELECT id FROM ingest_log WHERE source_ref = 'notes/reason-delete' AND source_type = 'secret-redacted'")).rows).toEqual([]);
    } finally { await e.exec("DROP TRIGGER reject_reason_version ON page_versions; DROP FUNCTION reject_reason_version()"); }
    await deletePage(db.storage, "notes/reason-delete", undefined, undefined, { changeReason: secret });
    const latest = (await pageVersions(db.storage, "notes/reason-delete"))[0]!;
    expect(latest.change_reason).toContain("REDACTED:github-token");
    expect(JSON.stringify(latest)).not.toContain(secret);
    expect((await e.query("SELECT id FROM ingest_log WHERE source_ref = 'notes/reason-delete' AND source_type = 'secret-redacted'")).rows).toHaveLength(1);
  });
  it("rejects credential-bearing delete and revert reasons without changing page history", async () => {
    await putPage(db.storage, { slug: "notes/reason-reject", markdown_body: "A" });
    await putPage(db.storage, { slug: "notes/reason-reject", markdown_body: "B" });
    const before = await pageVersions(db.storage, "notes/reason-reject");
    const prior = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    const secret = `${"gh"}p_${"B8az".repeat(9)}`;
    try {
      await expect(deletePage(db.storage, "notes/reason-reject", undefined, undefined, { changeReason: secret })).rejects.toMatchObject({ code: "invalid_params" });
      await expect(revertPage(db.storage, "notes/reason-reject", 1, undefined, undefined, { changeReason: secret })).rejects.toMatchObject({ code: "invalid_params" });
      expect((await getPage(db.storage, "notes/reason-reject"))!.markdown_body).toBe("B");
      expect(await pageVersions(db.storage, "notes/reason-reject")).toEqual(before);
      const audit = await db.storage.engine().query("SELECT summary FROM ingest_log WHERE source_ref='notes/reason-reject' AND source_type='secret-rejected'");
      expect(audit.rows).toHaveLength(2);
      expect(JSON.stringify(audit.rows)).not.toContain(secret);
    } finally {
      if (prior === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
      else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = prior;
    }
  });
});
