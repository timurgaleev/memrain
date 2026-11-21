/**
 * The secret store: a redaction on the page write path keeps the original it
 * removed, sealed under the connector key. The owner can read it back
 * (reveal), put a false positive back while the page still holds its marker
 * (restore), and purging a page removes the originals only it held.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { Storage } from "../src/core/storage.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, putPage, renamePage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { withSecretDisposition } from "../src/core/secret-scan.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { rotateKek } from "../src/core/connectors/vault-rotate.ts";
import {
  applySecretRestore,
  listSecretOriginals,
  previewSecretRestore,
  revealSecret,
} from "../src/core/secret-store.ts";

// Obviously fake key shapes, assembled so no literal key sits in the source.
const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
const AWS2 = ["AK", "IA", "Q3EXAMPLE7WXYZ34"].join("");
const MARKER = /\[REDACTED:([a-z0-9-]+):([0-9a-f]{16})\]/g;

let storage: Storage;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_SECRET_SCAN_DISPOSITION"] as const;
const KEY = randomBytes(32);

function markersOf(text: string): Array<{ marker: string; kind: string; fingerprint: string }> {
  return [...text.matchAll(MARKER)].map((m) => ({ marker: m[0], kind: m[1]!, fingerprint: m[2]! }));
}

async function bodyOf(slug: string): Promise<string> {
  return (await getPage(storage, slug))?.markdown_body ?? "";
}

async function storeRows(): Promise<string> {
  const e = await storage.engine().query("SELECT * FROM secret_store");
  const o = await storage.engine().query("SELECT * FROM secret_store_occurrences");
  return JSON.stringify([e.rows, o.rows]);
}

async function expire(slug: string): Promise<void> {
  await deletePage(storage, slug);
  await storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = $1`, [slug]);
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(name, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
    delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    process.env.MEMRAIN_CONNECTOR_KEK = KEY.toString("base64");
    db = await open();
    storage = db.storage;
  });
  afterEach(async () => {
    await db.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("sealing on the page write path", () => {
    it("keeps the redacted original sealed, never in clear, and reveals it to the owner", async () => {
      await putPage(storage, { slug: "notes/keys", markdown_body: `deploy key ${AWS} for staging\n` });
      const [m] = markersOf(await bodyOf("notes/keys"));
      expect(m).toBeDefined();
      expect(await storeRows()).not.toContain(AWS);

      const revealed = await revealSecret(storage.engine(), { slug: "notes/keys", fingerprint: m!.fingerprint }, "test");
      expect(revealed.value).toBe(AWS);
      expect(revealed.kind).toBe(m!.kind);
      expect(revealed.slugs).toEqual(["notes/keys"]);

      const audit = await storage.engine().query<{ summary: string; source_ref: string }>(
        `SELECT summary, source_ref FROM ingest_log WHERE source_type = 'secret-revealed'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows)).not.toContain(AWS);
      expect(audit.rows[0]!.summary).toContain(m!.fingerprint);
    });

    it("seals the title and the truth too", async () => {
      await putPage(storage, { slug: "notes/t", title: `key ${AWS}`, compiled_truth: { note: `key ${AWS2}` }, markdown_body: "x\n" });
      const listed = await listSecretOriginals(storage.engine(), { slug: "notes/t" });
      expect(listed.map((e) => e.fields.sort())).toEqual(expect.arrayContaining([["title"], ["truth"]]));
      expect(JSON.stringify(listed)).not.toContain(AWS);
    });

    it("one value on two pages is one entry with two places", async () => {
      await putPage(storage, { slug: "notes/a", markdown_body: `a ${AWS}\n` });
      await putPage(storage, { slug: "notes/b", markdown_body: `b ${AWS}\n` });
      const all = await listSecretOriginals(storage.engine(), {});
      expect(all).toHaveLength(1);
      expect(all[0]!.slugs).toEqual(["notes/a", "notes/b"]);
    });

    it("refuses an entry whose row was changed or whose key is not loaded", async () => {
      await putPage(storage, { slug: "notes/k", markdown_body: `k ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/k"));
      await storage.engine().query(`UPDATE secret_store SET source_id = source_id, kind = 'other'`);
      // The kind is not bound; the source and fingerprint are.
      expect((await revealSecret(storage.engine(), { slug: "notes/k", fingerprint: m!.fingerprint }, "t")).value).toBe(AWS);
      const swapped = await storage.engine().query<{ ciphertext: string }>(`SELECT ciphertext FROM secret_store`);
      await putPage(storage, { slug: "notes/k2", markdown_body: `k ${AWS2}\n` });
      const [m2] = markersOf(await bodyOf("notes/k2"));
      await storage.engine().query(`UPDATE secret_store SET ciphertext = $1 WHERE fingerprint = $2`, [swapped.rows[0]!.ciphertext, m2!.fingerprint]);
      await expect(revealSecret(storage.engine(), { slug: "notes/k2", fingerprint: m2!.fingerprint }, "t")).rejects.toMatchObject({ code: "vault_tamper" });
      process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
      await expect(revealSecret(storage.engine(), { slug: "notes/k", fingerprint: m!.fingerprint }, "t")).rejects.toMatchObject({ code: "vault_wrong_key" });
    });

    it("without a key the write goes ahead and nothing is kept", async () => {
      delete process.env.MEMRAIN_CONNECTOR_KEK;
      const r = await putPage(storage, { slug: "notes/nokey", markdown_body: `x ${AWS}\n` });
      expect(r.changed).toBe(true);
      expect(markersOf(await bodyOf("notes/nokey"))).toHaveLength(1);
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(0);
    });

    it("keeps nothing for a write that opts out (connector pages) or under flag", async () => {
      await putPage(storage, { slug: "mail/x", markdown_body: `pin ${AWS}\n`, sealSecrets: false });
      await withSecretDisposition("flag", () => putPage(storage, { slug: "notes/flag", markdown_body: `x ${AWS2}\n` }));
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(0);
    });

    it("reveals only while the page or one of its versions still holds the marker", async () => {
      await putPage(storage, { slug: "notes/edit", markdown_body: `x ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/edit"));
      await putPage(storage, { slug: "notes/edit", markdown_body: "rewritten\n" });
      // The first version still holds it, so page_revert could bring it back.
      expect((await revealSecret(storage.engine(), { slug: "notes/edit", fingerprint: m!.fingerprint }, "t")).value).toBe(AWS);
      await storage.engine().query(`UPDATE page_versions SET body_snapshot = 'scrubbed' WHERE slug = 'notes/edit'`);
      await expect(revealSecret(storage.engine(), { slug: "notes/edit", fingerprint: m!.fingerprint }, "t")).rejects.toMatchObject({ code: "not_found" });
    });

    it("a marker typed into a page binds to nothing", async () => {
      await putPage(storage, { slug: "notes/real", markdown_body: `x ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/real"));
      await putPage(storage, { slug: "notes/copy", markdown_body: `copied ${m!.marker}\n` });
      expect((await listSecretOriginals(storage.engine(), {}))[0]!.slugs).toEqual(["notes/real"]);
      await expect(revealSecret(storage.engine(), { slug: "notes/copy", fingerprint: m!.fingerprint }, "t")).rejects.toMatchObject({ code: "not_found" });
    });
  });

  describe("restore of a false positive", () => {
    it("puts the original back under a preview hash, records a version, and stays back on later edits", async () => {
      await putPage(storage, { slug: "notes/fp", markdown_body: `id ${AWS} and ${AWS2}\n` });
      await putPage(storage, { slug: "notes/other", markdown_body: `x\n` });
      const [first] = markersOf(await bodyOf("notes/fp"));
      const preview = await previewSecretRestore(storage.engine(), { slug: "notes/fp", fingerprint: first!.fingerprint });
      expect(preview.fields).toEqual(["body"]);
      expect(JSON.stringify(preview)).not.toContain(AWS);
      await expect(applySecretRestore(storage, { slug: "notes/fp", fingerprint: first!.fingerprint, expect: "0000000000000000" }, "t"))
        .rejects.toMatchObject({ code: "conflict" });
      const before = (await storage.engine().query<{ n: number }>(`SELECT max(version_n)::int AS n FROM page_versions WHERE slug = 'notes/fp'`)).rows[0]!.n;
      const r = await applySecretRestore(storage, { slug: "notes/fp", fingerprint: first!.fingerprint, expect: preview.hash }, "t");
      expect(r.version_n).toBe(before + 1);
      expect(JSON.stringify(r)).not.toContain(AWS);
      const body = await bodyOf("notes/fp");
      expect(body).toContain(AWS);
      expect(body).not.toContain(AWS2);
      expect(markersOf(body)).toHaveLength(1);

      await putPage(storage, { slug: "notes/fp", markdown_body: `${body}more\n` });
      expect(await bodyOf("notes/fp")).toContain(AWS);
      // Allowed only in this source's pages and only that value.
      await putPage(storage, { slug: "notes/new", markdown_body: `again ${AWS}\n` });
      expect(await bodyOf("notes/new")).toContain(AWS);
    });

    it("allows the value before writing it back, so a failed write leaves the entry as it was", async () => {
      await putPage(storage, { slug: "notes/order", markdown_body: `x ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/order"));
      const preview = await previewSecretRestore(storage.engine(), { slug: "notes/order", fingerprint: m!.fingerprint });
      // A tombstone of the restored text makes the page write refuse.
      await storage.engine().query(`INSERT INTO page_purges (source_id, content_hash, slug) VALUES ('default', $1, 'notes/gone')`,
        [createHash("sha256").update(`x ${AWS}\n`, "utf8").digest("hex")]);
      await expect(applySecretRestore(storage, { slug: "notes/order", fingerprint: m!.fingerprint, expect: preview.hash }, "t")).rejects.toThrow();
      expect((await storage.engine().query<{ status: string }>(`SELECT status FROM secret_store`)).rows[0]!.status).toBe("active");
      expect(await bodyOf("notes/order")).not.toContain(AWS);
    });

    it("refuses once the page no longer holds the marker", async () => {
      await putPage(storage, { slug: "notes/gone", markdown_body: `x ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/gone"));
      await putPage(storage, { slug: "notes/gone", markdown_body: `rewritten\n` });
      await expect(previewSecretRestore(storage.engine(), { slug: "notes/gone", fingerprint: m!.fingerprint })).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses when the page changed since the preview", async () => {
      await putPage(storage, { slug: "notes/race", markdown_body: `x ${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/race"));
      const preview = await previewSecretRestore(storage.engine(), { slug: "notes/race", fingerprint: m!.fingerprint });
      await putPage(storage, { slug: "notes/race", markdown_body: `${await bodyOf("notes/race")}edit\n` });
      await expect(applySecretRestore(storage, { slug: "notes/race", fingerprint: m!.fingerprint, expect: preview.hash }, "t"))
        .rejects.toMatchObject({ code: "conflict" });
      expect(await bodyOf("notes/race")).not.toContain(AWS);
    });
  });

  describe("purge and rename", () => {
    it("purging a page removes the originals only it held", async () => {
      await putPage(storage, { slug: "notes/one", markdown_body: `${AWS} ${AWS2}\n` });
      await putPage(storage, { slug: "notes/two", markdown_body: `${AWS}\n` });
      await expire("notes/one");
      // Soft-deleted, inside its window: still held.
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(2);
      const r = await purgeDeletedPages(storage.engine(), undefined, undefined, { slugs: ["notes/one"] });
      expect(r.secret_originals).toBe(1);
      const left = await listSecretOriginals(storage.engine(), {});
      expect(left).toHaveLength(1);
      expect(left[0]!.slugs).toEqual(["notes/two"]);
      await expire("notes/two");
      await purgeDeletedPages(storage.engine());
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(0);
      expect((await storage.engine().query(`SELECT 1 FROM secret_store_occurrences`)).rows).toHaveLength(0);
    });

    it("two pages purged together that share an original remove it once", async () => {
      await putPage(storage, { slug: "notes/p1", markdown_body: `${AWS}\n` });
      await putPage(storage, { slug: "notes/p2", markdown_body: `${AWS}\n` });
      await expire("notes/p1");
      await expire("notes/p2");
      const r = await purgeDeletedPages(storage.engine());
      expect(r.secret_originals).toBe(1);
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(0);
    });

    it("a rename moves the places with the page; a page that takes the old slug holds nothing", async () => {
      await putPage(storage, { slug: "notes/old", markdown_body: `${AWS}\n` });
      const [m] = markersOf(await bodyOf("notes/old"));
      await renamePage(storage, "notes/old", "notes/new");
      expect((await listSecretOriginals(storage.engine(), {}))[0]!.slugs).toEqual(["notes/new"]);
      expect((await revealSecret(storage.engine(), { slug: "notes/new", fingerprint: m!.fingerprint }, "t")).value).toBe(AWS);
      await expect(revealSecret(storage.engine(), { slug: "notes/old", fingerprint: m!.fingerprint }, "t")).rejects.toMatchObject({ code: "not_found" });
    });
  });

  it("a connector key rotation reseals the store", async () => {
    await putPage(storage, { slug: "notes/rot", markdown_body: `${AWS}\n` });
    const [m] = markersOf(await bodyOf("notes/rot"));
    const next = randomBytes(32);
    const r = await rotateKek(storage.engine(), kekFromBytes(KEY), kekFromBytes(next));
    expect(r.secretOriginals).toBe(1);
    process.env.MEMRAIN_CONNECTOR_KEK = next.toString("base64");
    expect((await revealSecret(storage.engine(), { slug: "notes/rot", fingerprint: m!.fingerprint }, "t")).value).toBe(AWS);
  });
});
