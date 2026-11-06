/**
 * raw_data sidecar (migrations 023 + 078) — per-page raw payload store
 * (API responses, headers) keyed UNIQUE(slug, source), backing
 * put_raw_data / get_raw_data.
 *
 * Newest-wins upsert: re-putting the same (slug, source) REPLACES the payload
 * (the sidecar is a cache of the latest fetch, not a history). `source` here is
 * the DATA source label ('crustdata', an importer
 * name), NOT the tenant axis; tenancy rides the owning page's source_id via an
 * ownership guard on write and a pages join on read.
 */
import { auditSecrets, guardSecretsDeep, guardWrite, type SecretFinding } from "./secret-scan.ts";
import type { Storage } from "./storage.ts";
import { lockPageSlugs, validateSlug } from "./pages.ts";
import { wellFormJsonbValue } from "./well-form.ts";
import { PageNotFoundError } from "./operation-error.ts";

/** Upper bound on one payload's serialized size (defence vs unbounded writes). */
const MAX_RAW_DATA_BYTES = 1_000_000;

export interface RawDataRow {
  id: number;
  slug: string;
  source: string;
  data: Record<string, unknown>;
  created_at: string;
}

function normaliseSource(source: string): string {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("raw_data source must be a non-empty string");
  }
  return source.trim();
}

/**
 * Upsert one raw payload for (slug, source) on a live page. A scoped caller
 * (`sourceId` set) may only attach data to a page its own source owns — same
 * ownership guard as addTimelineEvent. Returns whether the row was created (vs replaced).
 */
export async function putRawData(
  storage: Storage,
  slug: string,
  source: string,
  data: Record<string, unknown>,
  sourceId?: string,
): Promise<{ slug: string; source: string; created: boolean }> {
  validateSlug(slug);
  const src = normaliseSource(source);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("raw_data data must be a plain object");
  }
  // Raw API payloads are where an auth header is most likely to land.
  const scope =
    typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
  const findings: SecretFinding[] = [];
  const safe = await guardWrite(storage.engine(), `${slug}#${src}`, scope, () =>
    guardSecretsDeep(wellFormJsonbValue(data), `raw_data '${slug}'`, findings)) as Record<string, unknown>;
  const json = JSON.stringify(safe);
  if (json.length > MAX_RAW_DATA_BYTES) {
    throw new Error(`raw_data payload exceeds ${MAX_RAW_DATA_BYTES} bytes`);
  }
  // raw_data has no foreign key to pages: a row on a missing or soft-deleted
  // page would be inherited by the next page created on that slug. FOR KEY
  // SHARE holds the page until the insert commits, so a purge's DELETE waits
  // and its leftover sweep sees this row.
  const ownerParams: unknown[] = [slug];
  if (scope !== null) ownerParams.push(scope);
  const r = await storage.engine().transaction(async (tx) => {
    // The slug lock first, as every page writer takes it (rename, merge).
    await lockPageSlugs(tx, slug);
    const owns = await tx.query(
      `SELECT 1 FROM pages WHERE slug = $1 AND deleted_at IS NULL${scope !== null ? " AND source_id = $2" : ""}
        FOR KEY SHARE`,
      ownerParams,
    );
    if (owns.rows.length === 0) {
      throw new PageNotFoundError(slug);
    }
    return tx.query<{ inserted: boolean }>(
      `INSERT INTO raw_data (slug, source, data)
       VALUES ($1, $2, $3::text::jsonb)
       ON CONFLICT (slug, source) DO UPDATE
         SET data = EXCLUDED.data,
             created_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [slug, src, json],
    );
  });
  await auditSecrets(storage.engine(), findings, `${slug}#${src}`, scope);
  return { slug, source: src, created: r.rows[0]?.inserted ?? false };
}


export interface GetRawDataOptions {
  /** Filter to one data-source label. */
  source?: string;
  limit?: number;
  /** Tenant scope (mig047, via the owning page). Omitted -> unscoped; `[]` -> nothing. */
  sourceIds?: string[];
}

/** Read the raw payload rows for a live (not soft-deleted) page, newest first. */
export async function getRawData(
  storage: Storage,
  slug: string,
  opts: GetRawDataOptions = {},
): Promise<RawDataRow[]> {
  validateSlug(slug);
  const params: unknown[] = [slug];
  const where: string[] = ["r.slug = $1"];
  if (typeof opts.source === "string" && opts.source.length > 0) {
    params.push(opts.source.trim());
    where.push(`r.source = $${params.length}`);
  }
  // A soft-deleted page's raw payloads go with it, like its body and mirror.
  let join = " JOIN pages p ON p.slug = r.slug AND p.deleted_at IS NULL";
  if (opts.sourceIds !== undefined) {
    params.push(opts.sourceIds);
    join += ` AND p.source_id = ANY($${params.length}::text[])`;
  }
  const limit =
    typeof opts.limit === "number" && opts.limit >= 1 && opts.limit <= 200
      ? Math.floor(opts.limit)
      : 50;
  params.push(limit);
  const r = await storage.engine().query<RawDataRow>(
    `SELECT r.id, r.slug, r.source, r.data, r.created_at::text AS created_at
       FROM raw_data r${join}
      WHERE ${where.join(" AND ")}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}
