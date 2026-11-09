import { createHash } from "node:crypto";
import type { Engine } from "./engine/interface.ts";

export type ErasureRow = Record<string, unknown>;
export interface ErasureForeignKey { child: string; parent: string; child_columns: string[]; parent_columns: string[] }
export interface ErasureCensus {
  tables: string[]; data: Map<string, ErasureRow[]>; schema_hash: string; data_hash: string; unsupported_stores: string[];
  mutation_triggers: Array<{ table_name: string; on_delete: boolean; on_insert_update: boolean }>;
  ruled_tables: string[];
}
const MAX_ROWS = 50_000;
const MAX_BYTES = 32 * 1024 * 1024;

export function erasureHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export const sqlName = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Credential/configuration stores are outside the content-erasure surface. Their
// schema is pinned, but their secret values are never read into a plan.
function contentTable(table: string): boolean {
  return !/^(?:oauth_|admin_|access_tokens$|config$|sources$|migrations$|runtime_config$)/.test(table);
}
export async function erasureSchema(engine: Engine) {
  const tables = (await engine.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
  const columns = (await engine.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows;
  const constraints = (await engine.query("SELECT c.relname AS table_name,con.conname,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,con.conname")).rows;
  const triggers = (await engine.query("SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname")).rows;
  const mutationTriggers = (await engine.query<{ table_name: string; on_delete: boolean; on_insert_update: boolean }>("SELECT c.relname AS table_name,(t.tgtype::int & 8)<>0 AS on_delete,(t.tgtype::int & 20)<>0 AS on_insert_update FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled<>'D' ORDER BY c.relname,t.tgname")).rows;
  const ruled = (await engine.query<{ tablename: string }>("SELECT DISTINCT tablename FROM pg_rules WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
  const unsupported = (await engine.query<{ name: string }>("SELECT schemaname||'.'||matviewname AS name FROM pg_matviews UNION ALL SELECT foreign_table_schema||'.'||foreign_table_name AS name FROM information_schema.foreign_tables UNION ALL SELECT 'public.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity AND row_security_active(c.oid) ORDER BY name")).rows.map(r => r.name);
  return { tables, unsupported_stores: unsupported, mutation_triggers: mutationTriggers, ruled_tables: ruled,
    schema_hash: erasureHash({ tables, columns, constraints, triggers, mutationTriggers, ruled, unsupported }) };
}
export async function erasureForeignKeys(engine: Engine): Promise<ErasureForeignKey[]> {
  return (await engine.query<ErasureForeignKey>(`SELECT CASE WHEN cn.nspname='public' THEN c.relname ELSE cn.nspname||'.'||c.relname END AS child,p.relname AS parent,
    ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num ORDER BY k.n) AS child_columns,
    ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(num,n) JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.num ORDER BY k.n) AS parent_columns
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_class p ON p.oid=con.confrelid
    JOIN pg_namespace n ON n.oid=p.relnamespace JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE con.contype='f' AND n.nspname='public' ORDER BY c.relname,con.conname`)).rows;
}
export async function readErasureCensus(engine: Engine): Promise<ErasureCensus> {
  const schema = await erasureSchema(engine);
  const data = new Map<string, ErasureRow[]>();
  let totalRows = 0;
  let totalBytes = 0;
  const deadline = Date.now() + 60_000;
  for (const table of schema.tables.filter(contentTable)) {
    if (Date.now() > deadline) throw new Error("Erasure census exceeded 60 seconds; no deletion is permitted");
    const size = (await engine.query<{ count: string; bytes: string }>(`SELECT COUNT(*)::text AS count,COALESCE(SUM(octet_length(to_jsonb(t)::text)),0)::text AS bytes FROM ${sqlName(table)} t`)).rows[0]!;
    totalRows += Number(size.count); totalBytes += Number(size.bytes);
    if (totalRows > MAX_ROWS || totalBytes > MAX_BYTES) throw new Error("Erasure census exceeds 50000 rows or 32 MiB; no deletion is permitted");
    const rows = (await engine.query<{ row: ErasureRow }>(`SELECT to_jsonb(t) AS row FROM ${sqlName(table)} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
    data.set(table, rows);
  }
  return { ...schema, data, data_hash: erasureHash([...data]) };
}
