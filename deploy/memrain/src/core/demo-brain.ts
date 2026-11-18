/**
 * Demo memory for a member trying /app with nothing of their own yet: the
 * fictional corpus the search bench ships (src/eval/bench/corpus/vault),
 * loaded into a source of its own, `demo-<member>`.
 *
 * The member reads it through a group of the same name that holds only that
 * member and only that source, so the member's chat and every credential
 * bound to the member see it, nobody else does, and nothing is written to the
 * personal source. Removing it deletes the group and every row of the source
 * in every table that has a `source_id` column (read from the catalog, so a
 * table added later is covered), the slug-keyed leftovers of its pages, and
 * the source itself, then checks that no row is left.
 *
 * Indexing embeds the pages through the normal paid path, so the spend is
 * booked and capped like any other write (about 60k tokens).
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import type { IndexFileOptions } from "./indexer.ts";
import { putPage } from "./pages.ts";
import { indexPageIntoSearch } from "./page-index.ts";
import { OnboardingError } from "./onboarding.ts";
import { writeMemberAudit, type MemberActor } from "./members.ts";
import { leftovers } from "./pages-purge.ts";
import { benchCorpusFiles } from "../eval/bench/harness.ts";

const ID_MAX = 63;
const BENCH_PREFIX = "/bench/vault/";

/** The demo source (and group) of a member; hashed when the plain name would not fit. */
export function demoSourceId(memberId: string): string {
  const plain = `demo-${memberId}`;
  return plain.length <= ID_MAX ? plain : `demo-${createHash("sha256").update(memberId, "utf8").digest("hex").slice(0, 32)}`;
}

const actorOf = (memberId: string): MemberActor => ({ actor: `member:${memberId}`, via: "app" });

/**
 * The demo is this member's only when its group holds exactly this member and
 * exactly this source, no member has the source as a personal source and no
 * other group grants it. A source that merely has the name is not one.
 */
const OWNED_SQL = `SELECT 1 FROM sources s
   WHERE s.id = $1
     AND (SELECT array_agg(gm.member_id) FROM group_members gm WHERE gm.group_id = $1) = ARRAY[$2::text]
     AND (SELECT array_agg(gs.source_id) FROM group_sources gs WHERE gs.group_id = $1) = ARRAY[$1::text]
     AND NOT EXISTS (SELECT 1 FROM group_sources o WHERE o.source_id = $1 AND o.group_id <> $1)
     AND NOT EXISTS (SELECT 1 FROM members m WHERE m.personal_source_id = $1)`;

export async function demoLoaded(engine: Pick<Engine, "query">, memberId: string): Promise<boolean> {
  const r = await engine.query(OWNED_SQL, [demoSourceId(memberId), memberId]);
  return r.rows.length > 0;
}

export interface DemoLoad {
  source_id: string;
  pages: number;
  already: boolean;
}

export async function loadDemo(storage: Storage, memberId: string, opts: { embedFn?: IndexFileOptions["embedFn"] } = {}): Promise<DemoLoad> {
  const engine = storage.engine();
  const source = demoSourceId(memberId);
  if (await demoLoaded(engine, memberId)) {
    const n = await engine.query<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id = $1`, [source]);
    return { source_id: source, pages: Number(n.rows[0]?.n ?? 0), already: true };
  }
  const taken = await engine.query(`SELECT 1 FROM sources WHERE id = $1 UNION ALL SELECT 1 FROM groups WHERE id = $1`, [source]);
  if (taken.rows.length > 0) {
    throw new OnboardingError("demo_unavailable", 409, "The demo cannot be loaded: its name is already in use on this brain. Ask the brain operator.");
  }
  // The source, the group and the grant commit together, so the demo is
  // either this member's or not there at all.
  await engine.transaction(async (tx) => {
    // A plain insert, not registerSource's upsert: a source of this name made
    // since the check above is left alone and the load refused.
    const made = await tx.query(
      `INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [source, `/${source}/`],
    );
    if (made.rows.length === 0) {
      throw new OnboardingError("demo_unavailable", 409, "The demo cannot be loaded: its name is already in use on this brain. Ask the brain operator.");
    }
    await tx.query(`INSERT INTO groups (id, display_name) VALUES ($1, 'Demo memory')`, [source]);
    await tx.query(`INSERT INTO group_sources (group_id, source_id) VALUES ($1, $1)`, [source]);
    await tx.query(`INSERT INTO group_members (group_id, member_id) VALUES ($1, $2)`, [source, memberId]);
    await writeMemberAudit(tx, actorOf(memberId), { groupId: source, memberId, action: "demo_load", detail: { source_id: source } });
  });
  let pages = 0;
  for (const f of benchCorpusFiles({ includeMail: false })) {
    const { title, body } = splitFrontmatter(f.text);
    // `pages.slug` is global, so the demo's slugs carry the source's name.
    const slug = `${source}/${f.sourcePath.slice(BENCH_PREFIX.length).replace(/\.md$/, "")}`;
    const name = title ?? slug.split("/").pop()!;
    await putPage(storage, { slug, title: name, markdown_body: body, source_id: source, written_by: "app-demo", trust_tier: "external" });
    await indexPageIntoSearch(storage, { slug, title: name, markdown_body: body, source_id: source } as never, opts.embedFn ? { embedFn: opts.embedFn } : {});
    pages++;
  }
  return { source_id: source, pages, already: false };
}

/** The corpus files carry YAML frontmatter; the page gets its title and the body after it. */
function splitFrontmatter(text: string): { title: string | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return { title: null, body: text };
  const title = /^title:[ \t]*(\S.*)$/m.exec(m[1]!)?.[1]?.trim() ?? null;
  return { title, body: text.slice(m[0].length).trim() };
}

/** Every table with a `source_id` column, a table before every table it holds a foreign key to. */
async function sourceTablesInDeleteOrder(engine: Pick<Engine, "query">): Promise<string[]> {
  const cols = await engine.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'source_id'
        AND c.table_name <> 'sources'
      ORDER BY c.table_name`,
  );
  const tables = cols.rows.map((r) => r.table_name).filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
  const fks = await engine.query<{ child: string; parent: string }>(
    `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f'`,
  );
  const set = new Set(tables);
  const children = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of fks.rows) if (child !== parent && set.has(child) && set.has(parent)) children.get(parent)!.add(child);
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    const ready = [...left].filter((t) => [...children.get(t)!].every((c) => !left.has(c)));
    for (const t of ready.length > 0 ? ready : [...left]) {
      order.push(t);
      left.delete(t);
    }
  }
  return order;
}

export interface DemoRemoval {
  source_id: string;
  removed: boolean;
  rows: Record<string, number>;
}

export async function removeDemo(engine: Engine, memberId: string): Promise<DemoRemoval> {
  const source = demoSourceId(memberId);
  if (!(await demoLoaded(engine, memberId))) return { source_id: source, removed: false, rows: {} };
  const tables = await sourceTablesInDeleteOrder(engine);
  const rows: Record<string, number> = {};
  const removed = await engine.transaction(async (tx) => {
    // Checked again under the locks: adding a member or a source to the group
    // takes a key-share lock on its row, which FOR UPDATE holds off until the end.
    await tx.query(`SELECT 1 FROM sources WHERE id = $1 FOR UPDATE`, [source]);
    await tx.query(`SELECT 1 FROM groups WHERE id = $1 FOR UPDATE`, [source]);
    if (!(await demoLoaded(tx, memberId))) return false;
    const slugs = (await tx.query<{ slug: string }>(`SELECT slug FROM pages WHERE source_id = $1`, [source])).rows.map((r) => r.slug);
    await tx.query(`DELETE FROM groups WHERE id = $1`, [source]);
    for (const t of tables) {
      // scope: upstream the member's own demo source, named from its session
      const r = await tx.query<{ n: number }>(`WITH d AS (DELETE FROM ${t} WHERE source_id = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [source]);
      const n = Number(r.rows[0]?.n ?? 0);
      if (n > 0) rows[t] = n;
    }
    if (slugs.length > 0) {
      // A slug the demo shares with a live page elsewhere keeps that page's rows.
      // scope: operator-only the slug-keyed leftovers are global, so any source's page on the slug keeps them
      const live = new Set((await tx.query<{ slug: string }>(`SELECT slug FROM pages WHERE slug = ANY($1::text[])`, [slugs])).rows.map((r) => r.slug));
      const gone = slugs.filter((s) => !live.has(s));
      if (gone.length > 0) await leftovers(tx, gone, true);
    }
    await tx.query(`DELETE FROM sources WHERE id = $1`, [source]);
    for (const t of tables) {
      const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE source_id = $1`, [source]);
      if (Number(r.rows[0]?.n ?? 0) > 0) throw new Error(`demo removal left rows in ${t}`);
    }
    await writeMemberAudit(tx, actorOf(memberId), { groupId: source, memberId, action: "demo_remove", detail: { source_id: source, rows } });
    return true;
  });
  return { source_id: source, removed, rows: removed ? rows : {} };
}
