/**
 * Offboarding a member together with its personal source
 * (`memrain member remove <id> --erase-personal-source [--apply --out DIR]`).
 *
 * A dry run counts what would go and changes nothing. Applying:
 *   1. exports the personal source's live pages (markdown) and the member's
 *      chat threads (JSON) into DIR, before anything is deleted;
 *   2. in one transaction: tombstones the member (email cleared), revokes
 *      its keys, OAuth grants and web sessions, deletes its passkeys and
 *      invites, erases its chat, deletes every row of the personal source in
 *      every table that has a `source_id` column (read from the catalog, so
 *      a table added later is covered without a code change), the slug-keyed
 *      leftovers of its pages, and the source itself; then checks that no
 *      row of the source is left and writes the receipt to member_audit.
 * Any failure rolls the whole erasure back; the export stays on disk.
 *
 * A credential of someone else that still reads the source (a group grant, a
 * shared PAT) is not deleted, only stripped by the source going away; a
 * client registered on the source blocks the erasure (its foreign key), and
 * the error says so.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { eraseOwnerChat, exportChatThreads } from "./chat/store.ts";
import { leftovers } from "./pages-purge.ts";
import { getMember, MemberError, writeMemberAudit, type MemberActor } from "./members.ts";

/** A refused erasure request the operator can fix (a missing --out). */
export class ErasureUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureUsageError";
  }
}

export interface ErasureReport {
  member_id: string;
  source_id: string;
  applied: boolean;
  /** Rows of the personal source per table (before the erasure). */
  rows: Record<string, number>;
  chat: { threads: number; messages: number };
  credentials: { tokens: number; enrollments: number; sessions: number; passkeys: number; invites: number };
  exported?: { dir: string; pages: number; threads: number };
}

async function sourceTables(engine: Pick<Engine, "query">): Promise<string[]> {
  const r = await engine.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'source_id'
        AND c.table_name <> 'sources'
      ORDER BY c.table_name`,
  );
  return r.rows.map((x) => x.table_name).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
}

/** `tables` ordered so a table comes before every table it holds a foreign key to. */
async function deletionOrder(engine: Pick<Engine, "query">, tables: string[]): Promise<string[]> {
  const fks = await engine.query<{ child: string; parent: string }>(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`,
  );
  const set = new Set(tables);
  const referencedBy = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of fks.rows) {
    if (child !== parent && set.has(child) && set.has(parent)) referencedBy.get(parent)!.add(child);
  }
  const order: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((t) => [...referencedBy.get(t)!].every((c) => !remaining.has(c)));
    // A cycle would never empty; take what is left in name order.
    const next = ready.length > 0 ? ready : [...remaining];
    for (const t of next) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return order;
}

async function countRows(engine: Pick<Engine, "query">, sourceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of await sourceTables(engine)) {
    // scope: operator-only the operator's offboarding counts every row of the one source it erases
    const r = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE source_id = $1`, [sourceId]);
    const n = Number(r.rows[0]?.n ?? 0);
    if (n > 0) out[table] = n;
  }
  return out;
}

async function credentialCounts(engine: Pick<Engine, "query">, memberId: string): Promise<ErasureReport["credentials"]> {
  const r = await engine.query<Record<string, number>>(
    // scope: operator-only one member's credentials, for the operator's offboarding report
    `SELECT (SELECT count(*) FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL)::int AS tokens,
            (SELECT count(*) FROM oauth_enrollments WHERE member_id = $1 AND revoked_at IS NULL)::int AS enrollments,
            (SELECT count(*) FROM member_web_sessions WHERE member_id = $1 AND revoked_at IS NULL)::int AS sessions,
            (SELECT count(*) FROM member_passkeys WHERE member_id = $1)::int AS passkeys,
            (SELECT count(*) FROM member_invites WHERE member_id = $1)::int AS invites`,
    [memberId],
  );
  const row = r.rows[0] ?? {};
  return {
    tokens: Number(row.tokens ?? 0), enrollments: Number(row.enrollments ?? 0), sessions: Number(row.sessions ?? 0),
    passkeys: Number(row.passkeys ?? 0), invites: Number(row.invites ?? 0),
  };
}

/** Write the source's live pages and the member's threads under `dir`. */
async function exportPersonal(engine: Engine, sourceId: string, ownerKey: string, dir: string): Promise<{ pages: number; threads: number }> {
  const root = resolve(dir);
  const pagesDir = join(root, "pages");
  mkdirSync(pagesDir, { recursive: true, mode: 0o700 });
  const pages = await engine.query<{ slug: string; title: string | null; type: string; markdown_body: string | null }>(
    // scope: operator-only the operator's export of the one source being erased
    `SELECT slug, title, type, markdown_body FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`,
    [sourceId],
  );
  let written = 0;
  for (const p of pages.rows) {
    const target = resolve(pagesDir, `${p.slug}.md`);
    if (!target.startsWith(`${pagesDir}/`)) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const header = `---\ntitle: ${JSON.stringify(p.title ?? p.slug)}\ntype: ${p.type}\n---\n`;
    writeFileSync(target, `${header}\n${p.markdown_body ?? ""}\n`, { mode: 0o600 });
    written++;
  }
  const threads = await exportChatThreads(engine, { ownerKey });
  writeFileSync(join(root, "chat.json"), `${JSON.stringify(threads, null, 2)}\n`, { mode: 0o600 });
  return { pages: written, threads: threads.length };
}

export async function eraseMemberPersonalSource(
  storage: Storage,
  memberId: string,
  opts: { apply: boolean; outDir?: string; actor: MemberActor },
): Promise<ErasureReport> {
  const engine = storage.engine();
  const member = await getMember(engine, memberId);
  if (!member) throw new MemberError("not_found", `no member "${memberId}"`);
  const sourceId = member.personal_source_id;
  if (!sourceId) throw new MemberError("not_found", `member "${member.id}" has no personal source to erase`);
  if (sourceId === "default") throw new MemberError("owner_source", "the default source is the operator's and is never erased with a member");
  const ownerKey = `member:${member.id}`;
  const chat = await eraseOwnerChat(engine, ownerKey, false);
  const report: ErasureReport = {
    member_id: member.id,
    source_id: sourceId,
    applied: false,
    rows: await countRows(engine, sourceId),
    chat,
    credentials: await credentialCounts(engine, member.id),
  };
  if (!opts.apply) return report;
  if (!opts.outDir) throw new ErasureUsageError("erasing a personal source needs --out DIR: it is exported there first");

  const exported = await exportPersonal(engine, sourceId, ownerKey, opts.outDir);
  await engine.transaction(async (tx) => {
    await tx.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [member.id]);
    await tx.query(
      `UPDATE members SET status = 'removed', removed_at = COALESCE(removed_at, now()), email = NULL, updated_at = now() WHERE id = $1`,
      [member.id],
    );
    await tx.query(`DELETE FROM group_members WHERE member_id = $1`, [member.id]);
    await tx.query(`UPDATE access_tokens SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [member.id]);
    await tx.query(`UPDATE oauth_enrollments SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [member.id]);
    await tx.query(`UPDATE member_web_sessions SET revoked_at = now() WHERE member_id = $1 AND revoked_at IS NULL`, [member.id]);
    await tx.query(`DELETE FROM member_passkeys WHERE member_id = $1`, [member.id]);
    await tx.query(`DELETE FROM member_invites WHERE member_id = $1`, [member.id]);
    await eraseOwnerChat(tx, ownerKey, true);

    const slugs = (await tx.query<{ slug: string }>(
      // scope: operator-only the pages of the one source being erased
      `SELECT slug FROM pages WHERE source_id = $1`, [sourceId],
    )).rows.map((r) => r.slug);
    await leftovers(tx, slugs, true);
    // Many keys to sources block rather than cascade, so every table's rows go
    // first, a referencing table before the table it references, then the source.
    for (const table of await deletionOrder(tx, await sourceTables(tx))) {
      // scope: operator-only deletes the rows of the one source being erased
      await tx.query(`DELETE FROM ${table} WHERE source_id = $1`, [sourceId]);
    }
    await tx.query(`UPDATE members SET personal_source_id = NULL WHERE personal_source_id = $1`, [sourceId]);
    await tx.query(`DELETE FROM sources WHERE id = $1`, [sourceId]);
    const left = await countRows(tx, sourceId);
    if (Object.keys(left).length > 0) throw new Error(`erasure left rows of ${sourceId}: ${JSON.stringify(left)}`);
    await writeMemberAudit(tx, opts.actor, {
      memberId: member.id,
      action: "erase_personal_source",
      detail: { source_id: sourceId, rows: report.rows, chat: report.chat, credentials: report.credentials, exported },
    });
  });
  return { ...report, applied: true, exported: { dir: resolve(opts.outDir), ...exported } };
}
