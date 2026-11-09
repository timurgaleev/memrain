import type { Engine } from "./engine/interface.ts";
import type { OpsCheckResult } from "./doctor-ops.ts";

export async function checkDbBackends(engine: Engine): Promise<OpsCheckResult> {
  const { rows } = await engine.query<{ pid: number; state: string; age_s: number; total: number }>(
    `SELECT pid, state, EXTRACT(EPOCH FROM now() - COALESCE(xact_start, query_start))::int AS age_s,
            count(*) OVER ()::int AS total
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND ((state IN ('idle in transaction', 'idle in transaction (aborted)') AND xact_start < now() - interval '5 minutes')
          OR (wait_event_type = 'Lock' AND query_start < now() - interval '60 seconds'))
      ORDER BY COALESCE(xact_start, query_start), pid LIMIT 10`,
  );
  return { ok: true, status: rows.length ? "warn" : "ok", detail: rows.length
    ? `${rows[0]!.total} backend(s) idle in transaction >5m or waiting on a lock >60s: ${rows.map(r => `pid=${r.pid} state=${r.state} age=${r.age_s}s`).join('; ')}; inspect the owning process before taking action`
    : "no visible backend idle in transaction >5m or waiting on a lock >60s" };
}

const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function checkJsonbIntegrity(engine: Engine): Promise<OpsCheckResult> {
  const columns = await engine.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'jsonb' ORDER BY table_name, column_name`,
  );
  if (columns.rows.length === 0) return { ok: true, status: "ok", detail: "no jsonb columns to inspect" };
  const params: string[] = [];
  const scans = columns.rows.map(({ table_name, column_name }) => {
    params.push(`${table_name}.${column_name}`);
    const column = identifier(column_name);
    return `SELECT $${params.length}::text AS field, count(*)::int AS n FROM public.${identifier(table_name)}
      WHERE jsonb_typeof(${column}) = 'string' AND (${column} #>> '{}') ~ '^[[:space:]]*(\\{|\\[)'`;
  });
  const { rows } = await engine.query<{ field: string; n: number }>(`SELECT * FROM (${scans.join(' UNION ALL ')}) candidates WHERE n > 0 ORDER BY field`, params);
  return { ok: true, status: rows.length ? "warn" : "ok", detail: rows.length
    ? `suspected double-encoded jsonb: ${rows.map(r => `${r.field}=${r.n}`).join(', ')}; inspect before repairing; no values changed`
    : `no suspected double-encoded objects/arrays in ${columns.rows.length} jsonb column(s)` };
}

export async function checkPageVersionStorage(engine: Engine): Promise<OpsCheckResult> {
  const totals = await engine.query<{ versions: number; bytes: number }>(
    `SELECT count(*)::int AS versions, pg_total_relation_size('page_versions')::float8 AS bytes FROM page_versions`,
  );
  const top = await engine.query<{ slug: string; versions: number; bytes: number }>(
    `SELECT slug, count(*)::int AS versions,
            sum(octet_length(body_snapshot) + octet_length(compiled_truth_snapshot::text))::float8 AS bytes
       FROM page_versions GROUP BY slug ORDER BY bytes DESC, slug LIMIT 5`,
  );
  const total = totals.rows[0]!;
  return { ok: true, status: "ok", detail: `${total.versions} version(s); relation+indexes=${total.bytes} bytes; top snapshot payloads: ${top.rows.map(r => `${r.slug}=${r.bytes} bytes/${r.versions} versions`).join('; ') || 'none'}; no versions pruned` };
}
