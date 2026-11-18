/**
 * `member remove <id> --erase-personal-source`: offboarding a member takes
 * the member's personal source with it, after exporting it.
 *
 * A dry run counts and changes nothing. Applying exports the source's pages
 * and the member's chat threads first, then removes the member (tombstone,
 * email cleared), revokes every credential and web session, deletes the
 * passkeys and invites, erases the member's chat, and deletes every row of
 * the personal source: afterwards no table with a `source_id` column (read
 * from the catalog) holds one row of it. A receipt stays in member_audit.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, getMember, listMemberAudit, type MemberActor } from "../src/core/members.ts";
import { createMemberSession } from "../src/core/member-sessions.ts";
import { mintMemberInvite } from "../src/core/member-invites.ts";
import { appendChatMessage, createChatThread } from "../src/core/chat/store.ts";
import { eraseMemberPersonalSource } from "../src/core/member-offboarding.ts";
import { deterministicEmbedQuery } from "./det-embed.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };
const PAT = `memrain_${"e5".repeat(32)}`;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`member offboarding (${name})`, () => {
  it("exports, then leaves no row of the personal source in any table, with a receipt", async () => {
    const db = await open();
    const storage = db.storage;
    const e = storage.engine();
    const out = mkdtempSync(join(tmpdir(), "memrain-offboard-out-"));
    try {
      await registerSource(e, { id: "person-alice", kind: "other", pathPrefix: "/person-alice" });
      await addMember(e, "alice", { personalSource: "person-alice", email: "alice@example.test" }, OPS);
      const body = "Alice's notes: the north bed gets tomatoes.";
      await putPage(storage, { slug: "notes/alice-garden", markdown_body: body, title: "Garden", source_id: "person-alice" });
      await putPage(storage, { slug: "notes/alice-garden", markdown_body: `${body} And basil.`, title: "Garden", source_id: "person-alice" });
      await indexPageIntoSearch(storage, { slug: "notes/alice-garden", markdown_body: body, title: "Garden", source_id: "person-alice" } as never, { embedFn: deterministicEmbedQuery });
      await e.query(`INSERT INTO tags (slug, tag, source_id) VALUES ('notes/alice-garden', 'garden', 'person-alice')`);
      await putPage(storage, { slug: "notes/operator-own", markdown_body: "Stays.", title: "Own" });
      const thread = await createChatThread(e, { key: "member:alice", sourceId: "person-alice", spendId: "memrain_chat_m_alice" }, "garden?");
      await appendChatMessage(e, thread, { role: "user", content: "garden?" });
      await createMemberSession(e, "alice", "passkey");
      await mintMemberInvite(e, "alice", 3600_000);
      await e.query(
        `INSERT INTO member_passkeys (id, member_id, user_handle, public_key, device_type, label) VALUES ('cred-1', 'alice', 'h', 'pk', 'multiDevice', 'Laptop')`,
      );
      await e.query(
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions, member_id) VALUES ('alice-cli', $1, ARRAY['read'], $2::jsonb, 'alice')`,
        [createHash("sha256").update(PAT).digest("hex"), { source_id: ["person-alice"] }],
      );

      const plan = await eraseMemberPersonalSource(storage, "alice", { apply: false, actor: OPS });
      expect(plan.applied).toBe(false);
      expect(plan.source_id).toBe("person-alice");
      expect(plan.rows.pages).toBe(1);
      expect(plan.chat.threads).toBe(1);
      expect((await getMember(e, "alice"))?.status).toBe("enabled");

      await expect(eraseMemberPersonalSource(storage, "alice", { apply: true, actor: OPS })).rejects.toThrow(/--out/);

      const done = await eraseMemberPersonalSource(storage, "alice", { apply: true, outDir: out, actor: OPS });
      expect(done.applied).toBe(true);
      expect(readFileSync(join(out, "pages", "notes", "alice-garden.md"), "utf8")).toContain("basil");
      expect(existsSync(join(out, "chat.json"))).toBe(true);

      const tables = await e.query<{ table_name: string }>(
        `SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'source_id'`,
      );
      const left: string[] = [];
      for (const { table_name } of tables.rows) {
        const n = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name} WHERE source_id = 'person-alice'`);
        if (Number(n.rows[0]!.n) > 0) left.push(table_name);
      }
      expect(left).toEqual([]);
      expect((await e.query(`SELECT 1 FROM sources WHERE id = 'person-alice'`)).rows.length).toBe(0);
      expect((await e.query(`SELECT 1 FROM pages WHERE slug = 'notes/operator-own'`)).rows.length).toBe(1);

      const member = await getMember(e, "alice");
      expect(member).toMatchObject({ status: "removed", email: null, personal_source_id: null });
      for (const [table, where] of [
        ["chat_threads", "owner_key = 'member:alice'"],
        ["member_passkeys", "member_id = 'alice'"],
        ["member_invites", "member_id = 'alice'"],
        ["member_web_sessions", "member_id = 'alice' AND revoked_at IS NULL"],
        ["access_tokens", "member_id = 'alice' AND revoked_at IS NULL"],
      ] as const) {
        expect({ table, n: (await e.query(`SELECT 1 FROM ${table} WHERE ${where}`)).rows.length }).toEqual({ table, n: 0 });
      }
      const receipt = (await listMemberAudit(e, { memberId: "alice" })).find(r => r.action === "erase_personal_source");
      expect(receipt?.detail).toMatchObject({ source_id: "person-alice", exported: { pages: 1, threads: 1 } });
    } finally {
      rmSync(out, { recursive: true, force: true });
      await db.close();
    }
  });
});
