/**
 * The secret store: where a page write keeps the credential its redaction
 * removed (migration 180).
 *
 * A page write collects the values its scans replace (withSecretOriginals in
 * secret-scan.ts). Once the page row is written, every value whose marker
 * `[REDACTED:<kind>:<fingerprint>]` the stored title, body or truth holds is
 * sealed under the connector key (connectors/vault.ts) with its source and
 * fingerprint as additional authenticated data, and each place the marker
 * landed is recorded. A marker typed into a page by hand binds to nothing.
 *
 * Reveal and restore act only through those recorded places. Restore puts a
 * false positive back while the page still holds its marker, as a new page
 * version, and allows the value in that source so later writes leave it
 * alone. Purging a page removes its places and every entry no other page
 * still holds. No function here logs, returns or stores a value, except
 * revealSecret, whose caller decides who may call it.
 */
import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";
import type { Storage } from "./storage.ts";
import { loadKek, seal, unseal, VaultError, type Kek } from "./connectors/vault.ts";
import { logIngest } from "./ingest-log.ts";
import { appendAudit, auditDir } from "./audit-week-file.ts";
import { OperationError } from "./operation-error.ts";
import type { SecretOriginal } from "./secret-scan.ts";
import { carryForwardFences, OUTSIDE_NEUTRALIZED } from "./fence-carry.ts";

export type SecretField = "body" | "title" | "truth";
const MARKER = /\[REDACTED:([a-z0-9-]{1,64}):([0-9a-f]{16})\]/g;
const FINGERPRINT = /^[0-9a-f]{16}$/;
/** A body full of credential-shaped assignments must not turn one write into thousands of sealed rows. */
const MAX_SEALED_PER_WRITE = 256;

export function secretStoreAad(sourceId: string, fingerprint: string, kekId: string): string {
  return `memrain:secret-store:v1|${sourceId}|${fingerprint}|${kekId}`;
}

let warnedNoKey = false;

/** The key new entries are sealed with, or null (the write goes ahead and keeps nothing). */
function sealingKey(): Kek | null {
  const load = loadKek();
  if (load.kek !== null) return load.kek;
  if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn(`[secret_store] redacted originals are not kept: ${load.reason}`);
  }
  return null;
}

function readingKey(): Kek {
  const load = loadKek();
  if (load.kek === null) throw new VaultError("vault_no_key", `the secret store cannot be read: ${load.reason}`);
  return load.kek;
}

/** The fingerprints of the values the owner restored in this source: redaction leaves them alone. */
export async function allowedSecretFingerprints(engine: Engine, sourceId: string): Promise<Set<string>> {
  const r = await engine.query<{ fingerprint: string }>(
    `SELECT fingerprint FROM secret_store WHERE source_id = $1 AND status = 'allowed'`,
    [sourceId],
  );
  return new Set(r.rows.map((row) => row.fingerprint));
}

/**
 * Inside the page write's transaction: seal each collected original whose
 * marker the stored fields hold, and record where. Returns the number of
 * places recorded; 0 when no key is configured.
 */
export async function sealPageOriginals(
  tx: Engine,
  page: { slug: string; sourceId: string; fields: Record<SecretField, string> },
  originals: ReadonlyMap<string, SecretOriginal>,
): Promise<number> {
  const places: Array<{ original: SecretOriginal; field: SecretField; marker: string }> = [];
  for (const [field, text] of Object.entries(page.fields) as Array<[SecretField, string]>) {
    for (const m of text.matchAll(MARKER)) {
      const original = originals.get(m[2]!);
      if (original) places.push({ original, field, marker: m[0] });
    }
  }
  if (places.length === 0) return 0;
  // One lock order for every writer and the purge (by fingerprint), so two writes cannot deadlock on two shared entries.
  places.sort((a, b) => a.original.fingerprint.localeCompare(b.original.fingerprint));
  if (new Set(places.map((p) => p.original.fingerprint)).size > MAX_SEALED_PER_WRITE) {
    console.warn(`[secret_store] page '${page.slug}': more than ${MAX_SEALED_PER_WRITE} redacted values in one write; the rest are not kept`);
  }
  const kek = sealingKey();
  if (kek === null) return 0;
  const entryIds = new Map<string, number>();
  let recorded = 0;
  for (const { original, field, marker } of places) {
    let id = entryIds.get(original.fingerprint);
    if (id === undefined) {
      if (entryIds.size >= MAX_SEALED_PER_WRITE) continue;
      const sealed = seal(kek, original.value, secretStoreAad(page.sourceId, original.fingerprint, kek.id));
      const r = await tx.query<{ id: string }>(
        `INSERT INTO secret_store (source_id, fingerprint, kind, kek_id, nonce, ciphertext)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id, fingerprint) DO UPDATE SET updated_at = secret_store.updated_at
         RETURNING id::text AS id`,
        [page.sourceId, original.fingerprint, original.kind, sealed.kek_id, sealed.nonce, sealed.ciphertext],
      );
      id = Number(r.rows[0]!.id);
      entryIds.set(original.fingerprint, id);
    }
    const r = await tx.query(
      `INSERT INTO secret_store_occurrences (entry_id, slug, field, marker) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING 1`,
      [id, page.slug, field, marker],
    );
    recorded += r.rows.length;
  }
  return recorded;
}

interface EntryRow {
  id: string;
  source_id: string;
  fingerprint: string;
  kind: string;
  kek_id: string;
  nonce: string;
  ciphertext: string;
  status: "active" | "allowed";
}

/**
 * The entry the page's recorded places bind to this fingerprint, while the
 * page or one of its versions still holds such a marker (a revert could bring
 * it back); otherwise not_found.
 */
async function entryOnPage(engine: Engine, slug: string, fingerprint: string): Promise<EntryRow> {
  if (!FINGERPRINT.test(fingerprint)) {
    throw new OperationError("invalid_params", "fingerprint must be the 16 hex digits the marker shows",
      "Copy it from the page's [REDACTED:<kind>:<fingerprint>] marker.");
  }
  const r = await engine.query<EntryRow>(
    // scope: the slug names one page (pages.slug is the key); its own source binds the entry
    `SELECT s.id::text AS id, s.source_id, s.fingerprint, s.kind, s.kek_id, s.nonce, s.ciphertext, s.status
       FROM secret_store s JOIN pages p ON p.slug = $1 AND p.source_id = s.source_id
      WHERE s.fingerprint = $2
        AND EXISTS (
          SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id AND o.slug = $1
             AND (strpos(COALESCE(p.title, '') || ' ' || p.markdown_body || ' ' || p.compiled_truth::text, o.marker) > 0
                  OR EXISTS (SELECT 1 FROM page_versions v WHERE v.slug = $1
                                AND strpos(v.body_snapshot || ' ' || COALESCE(v.compiled_truth_snapshot::text, ''), o.marker) > 0)))`,
    [slug, fingerprint],
  );
  const row = r.rows[0];
  if (!row) {
    throw new OperationError("not_found", `no kept original for marker ${fingerprint} on page '${slug}'`,
      "Only values redacted after the secret store was added are kept, and only on the page the redaction wrote them to.");
  }
  return row;
}

function openEntry(row: EntryRow): string {
  const value = unseal(readingKey(), row, secretStoreAad(row.source_id, row.fingerprint, row.kek_id));
  if (createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16) !== row.fingerprint) {
    throw new VaultError("vault_tamper", "secret store record failed authentication");
  }
  return value;
}

async function auditSecretAccess(engine: Engine, event: "revealed" | "restored", row: EntryRow, slug: string, actor: string): Promise<void> {
  await logIngest(engine, {
    source_type: `secret-${event}`,
    source_ref: slug,
    summary: `${row.kind}:${row.fingerprint} by ${actor}`,
    source_id: row.source_id,
  });
  const dir = auditDir();
  if (dir) appendAudit(dir, { ts: new Date().toISOString(), event: `secret-${event}`, slug, kind: row.kind, fingerprint: row.fingerprint, actor });
}

export interface RevealedSecret {
  slug: string;
  fingerprint: string;
  kind: string;
  source_id: string;
  status: "active" | "allowed";
  value: string;
  slugs: string[];
}

/** The original behind a marker on a page. Every call is audited without the value. */
export async function revealSecret(engine: Engine, ref: { slug: string; fingerprint: string }, actor: string): Promise<RevealedSecret> {
  const row = await entryOnPage(engine, ref.slug, ref.fingerprint);
  const value = openEntry(row);
  const slugs = await engine.query<{ slug: string }>(
    `SELECT DISTINCT slug FROM secret_store_occurrences WHERE entry_id = $1 ORDER BY slug`,
    [row.id],
  );
  await auditSecretAccess(engine, "revealed", row, ref.slug, actor);
  return {
    slug: ref.slug, fingerprint: row.fingerprint, kind: row.kind, source_id: row.source_id, status: row.status, value,
    slugs: slugs.rows.map((s) => s.slug),
  };
}

export interface SecretOriginalSummary {
  id: number;
  source_id: string;
  fingerprint: string;
  kind: string;
  status: "active" | "allowed";
  kek_id: string;
  readable: boolean;
  slugs: string[];
  fields: SecretField[];
  created_at: string;
}

/** Entries and where they occur, never a value. */
export async function listSecretOriginals(engine: Engine, filter: { slug?: string; sourceId?: string; limit?: number }): Promise<SecretOriginalSummary[]> {
  const r = await engine.query<Omit<SecretOriginalSummary, "readable" | "id"> & { id: string }>(
    // scope: operator listing; optional source filter
    `SELECT s.id::text AS id, s.source_id, s.fingerprint, s.kind, s.status, s.kek_id, s.created_at::text AS created_at,
            COALESCE((SELECT array_agg(DISTINCT o.slug ORDER BY o.slug) FROM secret_store_occurrences o WHERE o.entry_id = s.id), '{}') AS slugs,
            COALESCE((SELECT array_agg(DISTINCT o.field ORDER BY o.field) FROM secret_store_occurrences o WHERE o.entry_id = s.id), '{}') AS fields
       FROM secret_store s
      WHERE ($1::text IS NULL OR s.source_id = $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id AND o.slug = $2))
      ORDER BY s.created_at, s.id LIMIT $3`,
    [filter.sourceId ?? null, filter.slug ?? null, filter.limit ?? 1000],
  );
  const kekId = loadKek().kek?.id ?? null;
  return r.rows.map((row) => ({ ...row, id: Number(row.id), readable: row.kek_id === kekId }));
}

export interface SecretRestorePreview {
  slug: string;
  fingerprint: string;
  kind: string;
  status: "active" | "allowed";
  version_n: number;
  fields: SecretField[];
  markers: string[];
  hash: string;
  command: string;
}

interface LivePage {
  title: string | null;
  markdown_body: string;
  compiled_truth: unknown;
  source_id: string;
  version_n: number;
}

async function livePage(engine: Engine, slug: string): Promise<LivePage | null> {
  const r = await engine.query<LivePage>(
    // scope: operator-only restore of the one page the recorded place names
    `SELECT p.title, p.markdown_body, p.compiled_truth, p.source_id,
            (SELECT COALESCE(MAX(v.version_n), 0)::int FROM page_versions v WHERE v.slug = p.slug) AS version_n
       FROM pages p WHERE p.slug = $1 AND p.deleted_at IS NULL`,
    [slug],
  );
  return r.rows[0] ?? null;
}

function fieldText(page: LivePage, field: SecretField): string {
  if (field === "body") return page.markdown_body;
  if (field === "title") return page.title ?? "";
  return typeof page.compiled_truth === "string" ? page.compiled_truth : JSON.stringify(page.compiled_truth ?? {});
}

/** Which recorded places of this entry the live page still holds, under a hash the apply must present. */
export async function previewSecretRestore(engine: Engine, ref: { slug: string; fingerprint: string }): Promise<SecretRestorePreview> {
  const row = await entryOnPage(engine, ref.slug, ref.fingerprint);
  const page = await livePage(engine, ref.slug);
  const places = await engine.query<{ field: SecretField; marker: string }>(
    `SELECT DISTINCT field, marker FROM secret_store_occurrences WHERE entry_id = $1 AND slug = $2 ORDER BY field, marker`,
    [row.id, ref.slug],
  );
  const held = page ? places.rows.filter((p) => fieldText(page, p.field).includes(p.marker)) : [];
  if (!page || held.length === 0) {
    throw new OperationError("not_found", `page '${ref.slug}' no longer holds marker ${ref.fingerprint}`,
      "A restore puts an original back only into a live page that still holds its marker.");
  }
  const fields = [...new Set(held.map((p) => p.field))].sort();
  const markers = [...new Set(held.map((p) => p.marker))].sort();
  const hash = createHash("sha256")
    .update(JSON.stringify(["secret-restore-v1", ref.slug, row.fingerprint, row.status, page.version_n, fields, markers]))
    .digest("hex").slice(0, 16);
  return {
    slug: ref.slug, fingerprint: row.fingerprint, kind: row.kind, status: row.status, version_n: page.version_n,
    fields, markers, hash, command: `memrain secrets restore ${ref.slug} ${row.fingerprint} --apply --plan-hash ${hash}`,
  };
}

function replaceAll(text: string, markers: readonly string[], value: string): string {
  return markers.reduce((out, marker) => out.split(marker).join(value), text);
}

export interface SecretRestoreResult {
  slug: string;
  fingerprint: string;
  version_n: number;
  content_hash: string;
  fields: SecretField[];
  status: "allowed";
}

/**
 * Put the original back into the page as a new version, refusing when the
 * page changed since the preview, then allow the value in the page's source.
 */
export async function applySecretRestore(
  storage: Storage,
  ref: { slug: string; fingerprint: string; expect: string },
  actor: string,
): Promise<SecretRestoreResult> {
  const engine = storage.engine();
  const preview = await previewSecretRestore(engine, ref);
  if (preview.hash !== ref.expect) {
    throw new OperationError("conflict", `the restore preview changed (now ${preview.hash})`,
      `Review it again: memrain secrets restore ${ref.slug} ${ref.fingerprint}`);
  }
  const row = await entryOnPage(engine, ref.slug, ref.fingerprint);
  const value = openEntry(row);
  const page = (await livePage(engine, ref.slug))!;
  const truth = (page.compiled_truth ?? {}) as Record<string, unknown>;
  const jsonValue = JSON.stringify(value).slice(1, -1);
  const body = preview.fields.includes("body") ? replaceAll(page.markdown_body, preview.markers, value) : page.markdown_body;
  // A neutralized transcript or GitHub page stays neutralized, or its next re-import would hold on
  // every fence the brain added. Its fences are carried forward, so the restored body must be what they give back.
  const neutralized = truth[OUTSIDE_NEUTRALIZED] === 1;
  if (neutralized && carryForwardFences({ slug: ref.slug, markdown_body: page.markdown_body, compiled_truth: truth }, body) !== body) {
    throw new OperationError("conflict", `restoring ${row.fingerprint} on '${ref.slug}' would change a fence the page's re-import carries forward`,
      "Edit the fence by hand, or leave the value redacted.");
  }
  const { putPage } = await import("./pages.ts");
  // Allowed before the write, so no concurrent write redacts it again in between; a failed write puts the status back.
  await engine.query(`UPDATE secret_store SET status = 'allowed', updated_at = NOW() WHERE id = $1`, [row.id]);
  let put: Awaited<ReturnType<typeof putPage>>;
  try {
    put = await putPage(storage, {
    slug: ref.slug,
    source_id: page.source_id,
    title: preview.fields.includes("title") ? replaceAll(page.title ?? "", preview.markers, value) : (page.title ?? undefined),
    markdown_body: body,
    allowEmptyBody: true,
    ...(neutralized ? { outsideText: true as const } : {}),
    compiled_truth: preview.fields.includes("truth")
      ? JSON.parse(replaceAll(JSON.stringify(truth), preview.markers, jsonValue)) as Record<string, unknown>
      : truth,
    change_reason: `restore redacted ${row.kind}:${row.fingerprint}`,
    written_by: "secrets-restore",
    expectedVersion: preview.version_n,
    allowSecretFingerprints: [row.fingerprint],
    });
  } catch (error) {
    await engine.query(`UPDATE secret_store SET status = $2, updated_at = NOW() WHERE id = $1`, [row.id, row.status]);
    throw error;
  }
  // The page version is committed; a failed audit row must not report the restore as failed.
  await auditSecretAccess(engine, "restored", row, ref.slug, actor).catch((e: unknown) => {
    console.warn(`[secret_store] restore of ${row.fingerprint} on '${ref.slug}' not audited:`, e instanceof Error ? e.message : e);
  });
  if (put.changed) {
    const { mirrorPage } = await import("./page-index.ts");
    const fresh = await livePage(engine, ref.slug);
    if (fresh) {
      await mirrorPage(storage, { slug: ref.slug, title: fresh.title, markdown_body: fresh.markdown_body, content_hash: put.content_hash,
        source_id: fresh.source_id }, { remote: false, timingLabel: "secrets-restore", logLabel: ref.slug }).catch(() => false);
    }
  }
  return { slug: ref.slug, fingerprint: row.fingerprint, version_n: put.version_n, content_hash: put.content_hash, fields: preview.fields, status: "allowed" };
}

/**
 * Inside the purge transaction: remove the places on these pages, then every
 * entry no other page still holds. Returns the entries removed (or, with
 * `count`, that would be).
 */
export async function purgeSecretOriginals(tx: Engine, slugs: readonly string[], count = false): Promise<number> {
  if (slugs.length === 0) return 0;
  if (count) {
    const r = await tx.query<{ n: number }>(
      // scope: operator-only purge dry run over the pages the purge planned
      `SELECT count(*)::int AS n FROM secret_store s
        WHERE EXISTS (SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id AND o.slug = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id AND o.slug <> ALL($1::text[]))`,
      [[...slugs]],
    );
    return r.rows[0]?.n ?? 0;
  }
  const gone = await tx.query<{ entry_id: string }>(
    `DELETE FROM secret_store_occurrences WHERE slug = ANY($1::text[]) RETURNING entry_id::text AS entry_id`,
    [[...slugs]],
  );
  if (gone.rows.length === 0) return 0;
  const ids = [...new Set(gone.rows.map((g) => g.entry_id))].sort();
  // Lock first, so the delete below reads, in its own fresh snapshot, any place a concurrent write committed meanwhile.
  // scope: operator-only purge cascade over the entries the purged pages held
  await tx.query(`SELECT id FROM secret_store WHERE id = ANY($1::bigint[]) ORDER BY source_id, fingerprint FOR UPDATE`, [ids]);
  const r = await tx.query(
    // scope: operator-only purge cascade over the entries the purged pages held
    `DELETE FROM secret_store s WHERE s.id = ANY($1::bigint[])
       AND NOT EXISTS (SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id) RETURNING 1`,
    [ids],
  );
  return r.rows.length;
}

/** Inside a rename's transaction: the page's places move with it. */
export async function moveSecretOccurrences(tx: Engine, fromSlug: string, toSlug: string): Promise<void> {
  await tx.query(`UPDATE secret_store_occurrences SET slug = $2 WHERE slug = $1`, [fromSlug, toSlug]);
}

/** Entries no page holds any more (doctor). */
export async function unreferencedSecretOriginals(engine: Engine): Promise<number> {
  const r = await engine.query<{ n: number }>(
    // scope: operator-only doctor count over the whole store
    `SELECT count(*)::int AS n FROM secret_store s WHERE NOT EXISTS (SELECT 1 FROM secret_store_occurrences o WHERE o.entry_id = s.id)`,
  );
  return r.rows[0]?.n ?? 0;
}
