/**
 * Rows an earlier build wrote for features this one does not have, seeded with
 * plain SQL: facts and timeline events stay in a pre-Lite database, and the tests
 * that check no kept path exposes them need some on file.
 */
import type { Storage } from "../../src/core/storage.ts";

export interface SeedFact {
  entity_slug: string;
  fact: string;
  source_slug?: string;
  source_id?: string;
  visibility?: "world" | "private";
  written_by?: string;
  written_by_principal?: string;
}

export async function seedFact(storage: Storage, f: SeedFact): Promise<{ id: number }> {
  const r = await storage.engine().query<{ id: string }>(
    `INSERT INTO entity_facts (entity_slug, fact, source_slug, source_id, visibility, written_by, written_by_principal)
     VALUES ($1, $2, $3, COALESCE($4, 'default'), COALESCE($5, 'private'), $6, $7) RETURNING id::text AS id`,
    [f.entity_slug, f.fact, f.source_slug ?? null, f.source_id ?? null, f.visibility ?? null, f.written_by ?? "test", f.written_by_principal ?? null],
  );
  return { id: Number(r.rows[0]!.id) };
}

export interface SeedEvent {
  slug: string;
  occurred_at: string;
  event: string;
  detail?: string;
  source_label?: string;
  source_chunk_id?: string;
  source_id?: string;
}

export async function seedTimelineEvent(storage: Storage, e: SeedEvent): Promise<void> {
  await storage.engine().query(
    `INSERT INTO timeline_events (slug, occurred_at, event, detail, source_label, source_chunk_id, source_id)
     VALUES ($1, $2::timestamptz, $3, $4, $5, $6, COALESCE($7, 'default'))`,
    [e.slug, e.occurred_at, e.event, e.detail ?? "", e.source_label ?? "test", e.source_chunk_id ?? null, e.source_id ?? null],
  );
}

/** A raw_data row an earlier build's `put_raw_data` stored. */
export async function seedRawData(storage: Storage, slug: string, source: string, data: Record<string, unknown>): Promise<void> {
  await storage.engine().query(`INSERT INTO raw_data (slug, source, data) VALUES ($1, $2, $3::jsonb)`, [slug, source, JSON.stringify(data)]);
}

/** A member row as an earlier build's `member add` stored it. */
export async function seedMember(engine: Pick<Storage["engine"] extends () => infer E ? E : never, "query">, id: string, opts: { personalSource?: string; status?: "enabled" | "disabled" } = {}): Promise<void> {
  await engine.query(
    `INSERT INTO members (id, personal_source_id, status) VALUES ($1, $2, $3)`,
    [id, opts.personalSource ?? null, opts.status ?? "enabled"],
  );
}

/** Name the brain's owner member, as `member owner <id>` did (config access.owner_member). */
export async function seedOwner(engine: Pick<Storage["engine"] extends () => infer E ? E : never, "query">, id: string): Promise<void> {
  await engine.query(
    `INSERT INTO config (key, value, updated_at) VALUES ('access.owner_member', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [id],
  );
}
