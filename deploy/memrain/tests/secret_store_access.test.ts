/**
 * Who may read a kept original (reveal_secret), the encrypted backup of the
 * store, and its doctor check.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deletePage, getPage, putPage } from "../src/core/pages.ts";
import { purgeDeletedPages } from "../src/core/pages-purge.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { ADMIN_TOOLS, handleAdminTool } from "../src/http/admin-tool.ts";
import { listSecretOriginals } from "../src/core/secret-store.ts";
import { backupSecretStore, readBackupStatus, restoreSecretStoreBackup, secretStoreBackupDue } from "../src/core/secret-store-backup.ts";
import { checkSecretStore } from "../src/core/doctor-secrets.ts";

const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
const AWS2 = ["AK", "IA", "Q3EXAMPLE7WXYZ34"].join("");
const MARKER = /\[REDACTED:[a-z0-9-]+:([0-9a-f]{16})\]/;
const ENV_KEYS = ["MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_CONFIG_PATH"] as const;
const KEY = randomBytes(32);

let storage: Storage;
let home: string;
const saved: Record<string, string | undefined> = {};

async function fingerprintOn(slug: string): Promise<string> {
  return MARKER.exec((await getPage(storage, slug))!.markdown_body)![1]!;
}

const admin = (scopes: string[]): AuthInfo => ({ token: "tok", clientId: "client-x", scopes, isPublic: false });

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(name, () => {
  let db: Awaited<ReturnType<typeof open>>;
  beforeEach(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    home = mkdtempSync(join(tmpdir(), "memrain-secret-store-"));
    // Bun's homedir() ignores HOME; the config-path override keeps the store's files in the temp dir.
    process.env.MEMRAIN_CONFIG_PATH = join(home, "config.json");
    delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
    process.env.MEMRAIN_CONNECTOR_KEK = KEY.toString("base64");
    db = await open();
    storage = db.storage;
  });
  afterEach(async () => {
    await db.close();
    rmSync(home, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("reveal_secret", () => {
    const reveal = async (slug: string, fingerprint: string) => handleAdminTool(
      new Request("http://x/admin/api/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "reveal_secret", arguments: { slug, fingerprint } }),
      }),
      { storage },
    );

    it("the admin panel session reads the original", async () => {
      await putPage(storage, { slug: "notes/r", markdown_body: `k ${AWS}\n` });
      const fingerprint = await fingerprintOn("notes/r");
      const res = await reveal("notes/r", fingerprint);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { value: string } }).data.value).toBe(AWS);
      expect(ADMIN_TOOLS.has("reveal_secret")).toBe(true);
    });

    it("no MCP caller lists or calls it: the internal path, every token, the public bearer", async () => {
      await putPage(storage, { slug: "notes/r", markdown_body: `k ${AWS}\n` });
      const fingerprint = await fingerprintOn("notes/r");
      const callers: Parameters<typeof dispatchTool>[2][] = [
        {},
        { adminPanel: true },
        { isPublic: true, adminPanel: true },
        ...[["read"], ["read", "write"], ["admin"], ["agent"]].map((scopes) => ({ authInfo: admin(scopes), adminPanel: true })),
      ];
      for (const ctx of callers) {
        const r = await dispatchTool(storage, { name: "reveal_secret", arguments: { slug: "notes/r", fingerprint } }, ctx);
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r)).not.toContain(AWS);
      }
      expect(TOOL_DEFS.some((t) => t.name === "reveal_secret")).toBe(false);
    });

    it("a tampered entry is refused without the value", async () => {
      await putPage(storage, { slug: "notes/r", markdown_body: `k ${AWS}\n` });
      const fingerprint = await fingerprintOn("notes/r");
      await storage.engine().query(`UPDATE secret_store SET nonce = $1`, [randomBytes(12).toString("base64")]);
      const res = await reveal("notes/r", fingerprint);
      expect(res.status).not.toBe(200);
      const text = await res.text();
      expect(text).toContain("vault_tamper");
      expect(text).not.toContain(AWS);
    });
  });

  describe("encrypted backup", () => {
    it("holds no value, slug, fingerprint or kind in clear, is 0600, and restores only what a live page holds", async () => {
      await putPage(storage, { slug: "notes/kept", markdown_body: `k ${AWS}\n` });
      await putPage(storage, { slug: "notes/purged", markdown_body: `p ${AWS2}\n` });
      const kept = await fingerprintOn("notes/kept");
      const b = await backupSecretStore(storage.engine());
      expect(b.entries).toBe(2);
      const text = readFileSync(b.file, "utf8");
      for (const clear of [AWS, AWS2, "notes/kept", kept, "aws-access-key"]) expect(text).not.toContain(clear);
      expect(statSync(b.file).mode & 0o777).toBe(0o600);
      expect(readBackupStatus().last_success?.entries).toBe(2);
      expect(await secretStoreBackupDue(storage.engine())).toBe(false);

      await deletePage(storage, "notes/purged");
      await storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = 'notes/purged'`);
      await purgeDeletedPages(storage.engine());
      await storage.engine().query(`DELETE FROM secret_store`);
      const r = await restoreSecretStoreBackup(storage.engine(), b.file);
      expect(r).toMatchObject({ inserted: 1, skipped_no_page: 1, unreadable: 0, occurrences: 1 });
      const back = await listSecretOriginals(storage.engine(), {});
      expect(back.map((e) => [e.fingerprint, e.slugs])).toEqual([[kept, ["notes/kept"]]]);
      // Running it again adds nothing.
      expect(await restoreSecretStoreBackup(storage.engine(), b.file)).toMatchObject({ inserted: 0, existing: 1, occurrences: 0 });
    });

    it("never ties a backed-up original to a page created at its slug after the purge", async () => {
      await putPage(storage, { slug: "notes/reused", markdown_body: `k ${AWS}\n` });
      const marker = MARKER.exec((await getPage(storage, "notes/reused"))!.markdown_body)![0];
      const b = await backupSecretStore(storage.engine());
      await deletePage(storage, "notes/reused");
      await storage.engine().query(`UPDATE pages SET deleted_at = NOW() - interval '1000 hours' WHERE slug = 'notes/reused'`);
      await purgeDeletedPages(storage.engine());
      await putPage(storage, { slug: "notes/reused", markdown_body: `copied ${marker}\n` });
      await expect(restoreSecretStoreBackup(storage.engine(), b.file)).rejects.toMatchObject({ code: "invalid_params" });
      expect(await listSecretOriginals(storage.engine(), {})).toHaveLength(0);
    });

    it("refuses a backup under another key or with a changed byte", async () => {
      await putPage(storage, { slug: "notes/k", markdown_body: `k ${AWS}\n` });
      const b = await backupSecretStore(storage.engine());
      const doc = JSON.parse(readFileSync(b.file, "utf8"));
      const raw = Buffer.from(doc.ciphertext, "base64");
      raw[0] = raw[0]! ^ 1;
      const changed = join(home, "changed.json");
      writeFileSync(changed, JSON.stringify({ ...doc, ciphertext: raw.toString("base64") }));
      await expect(restoreSecretStoreBackup(storage.engine(), changed)).rejects.toMatchObject({ code: "vault_tamper" });
      process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
      await expect(restoreSecretStoreBackup(storage.engine(), b.file)).rejects.toMatchObject({ code: "vault_wrong_key" });
    });

    it("a store change makes the next backup due; without a key nothing is written", async () => {
      await putPage(storage, { slug: "notes/a", markdown_body: `a ${AWS}\n` });
      await backupSecretStore(storage.engine());
      await putPage(storage, { slug: "notes/b", markdown_body: `b ${AWS}\n` });
      expect(await secretStoreBackupDue(storage.engine())).toBe(true);
      delete process.env.MEMRAIN_CONNECTOR_KEK;
      const dir = join(home, "nokey");
      await expect(backupSecretStore(storage.engine(), { dir })).rejects.toMatchObject({ code: "vault_no_key" });
      expect(() => readdirSync(dir)).toThrow();
      expect(readBackupStatus().last_failure).not.toBeNull();
    });
  });

  describe("doctor secret-store", () => {
    it("is ok with nothing kept, warns until a backup holds the store, then is ok", async () => {
      expect((await checkSecretStore(storage.engine())).status).toBe("ok");
      await putPage(storage, { slug: "notes/d", markdown_body: `d ${AWS}\n` });
      const before = await checkSecretStore(storage.engine());
      expect(before.status).toBe("warn");
      expect(before.detail).toContain("never backed up");
      await backupSecretStore(storage.engine());
      expect((await checkSecretStore(storage.engine())).status).toBe("ok");
    });

    it("warns when the loaded key cannot read what is kept", async () => {
      await putPage(storage, { slug: "notes/d", markdown_body: `d ${AWS}\n` });
      process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
      const r = await checkSecretStore(storage.engine());
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("key this host does not hold");
      delete process.env.MEMRAIN_CONNECTOR_KEK;
      expect((await checkSecretStore(storage.engine())).detail).toContain("cannot be read here");
    });
  });
});
