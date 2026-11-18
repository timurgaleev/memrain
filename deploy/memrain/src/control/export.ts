/**
 * A tenant's data out, and a tenant deleted only behind a verified export.
 *
 * `exportTenant` copies the tenant database into a PGLite brain the customer
 * can run themselves (every table, checked by count and content hash against
 * the source), plus a markdown tree of the live pages and the chat threads as
 * JSON. A live export is the customer's copy; it never authorises a delete.
 *
 * `deleteTenant` fences the database first, at the database, not in the app:
 * the owner role loses LOGIN and CONNECT and every session on the database is
 * terminated, so nothing can write while the export runs. The export taken
 * then is checked against a database that no longer changes, and its receipt
 * names the fence. The tenant waits seven days in `deleting`; `purgeDeleted`
 * accepts only a good receipt taken under the current fence. Resuming the
 * tenant in the window lifts the fence and changes its id, so an old receipt
 * is worth nothing afterwards.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Engine } from "../core/engine/interface.ts";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { Storage } from "../core/storage.ts";
import { copyEngine, type TableReport } from "../core/engine-copy.ts";
import { exportChatThreads } from "../core/chat/store.ts";
import { urlForDatabase } from "./provision.ts";
import {
  TenantError,
  ident,
  logTenantEvent,
  requireTenant,
  tenantNames,
  withTenantLock,
  type TenantRow,
} from "./tenants.ts";

export const DELETE_WINDOW_DAYS = 7;

export interface ExportContext {
  /** Master-role URL of the control database. */
  masterUrl: string;
  control: Engine;
}

export interface ExportReceipt {
  id: string;
  tenantId: string;
  kind: "live" | "fenced";
  fenceId: string | null;
  outDir: string;
  ok: boolean;
  pages: number;
  tables: Pick<TableReport, "name" | "src" | "dst" | "match">[];
  failures: { table: string; error: string }[];
}

async function withMaster<T>(ctx: ExportContext, db: string, fn: (e: PostgresEngine) => Promise<T>): Promise<T> {
  const e = new PostgresEngine({ url: urlForDatabase(ctx.masterUrl, db), max: 2, statementTimeoutMs: 600_000 });
  try {
    return await fn(e);
  } finally {
    await e.close();
  }
}

interface PageRow {
  slug: string;
  type: string;
  title: string | null;
  markdown_body: string | null;
}

/** The live pages as markdown files, one per slug, and every chat thread as JSON. */
async function writeReadableCopy(src: Engine, outDir: string): Promise<number> {
  const mdDir = join(outDir, "markdown");
  const pages = await src.query<PageRow>(
    `SELECT slug, type, title, markdown_body FROM pages WHERE deleted_at IS NULL ORDER BY slug`,
  );
  let written = 0;
  for (const p of pages.rows) {
    const target = resolve(mdDir, `${p.slug}.md`);
    if (!target.startsWith(`${mdDir}/`)) continue;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const header = `---\ntitle: ${JSON.stringify(p.title ?? p.slug)}\ntype: ${p.type}\n---\n`;
    writeFileSync(target, `${header}\n${p.markdown_body ?? ""}\n`, { mode: 0o600 });
    written++;
  }
  const threads = await exportChatThreads(src, {});
  if (threads.length > 0) {
    mkdirSync(join(outDir, "chat"), { recursive: true, mode: 0o700 });
    for (const t of threads) writeFileSync(join(outDir, "chat", `${t.id}.json`), `${JSON.stringify(t, null, 2)}\n`, { mode: 0o600 });
  }
  return written;
}

async function exportInto(ctx: ExportContext, t: TenantRow, outDir: string, kind: "live" | "fenced"): Promise<ExportReceipt> {
  const out = resolve(outDir);
  // A used directory could still hold another export's pages next to this one's brain.
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new TenantError("wrong_state", `export directory ${out} is not empty; give a new one`);
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const brainDir = join(out, "brain");
  const dst = new Storage({ dbPath: brainDir });
  let summary: Awaited<ReturnType<typeof copyEngine>>;
  let pages: number;
  try {
    await dst.init();
    ({ summary, pages } = await withMaster(ctx, t.dbName, async (src) => ({
      summary: await copyEngine(src, dst.engine()),
      pages: await writeReadableCopy(src, out),
    })));
  } finally {
    await dst.close();
  }
  const receipt: ExportReceipt = {
    id: randomUUID(),
    tenantId: t.id,
    kind,
    fenceId: kind === "fenced" ? t.fenceId : null,
    outDir: out,
    ok: summary.ok,
    pages,
    tables: summary.tables.map(({ name, src, dst: d, match }) => ({ name, src, dst: d, match })),
    failures: summary.failures,
  };
  await ctx.control.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO tenant_exports (id, tenant_id, kind, fence_id, out_dir, tables, pages, ok)
       VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8)`,
      [receipt.id, t.id, kind, receipt.fenceId, out, JSON.stringify(receipt.tables), pages, receipt.ok],
    );
    await logTenantEvent(tx, t.id, `export:${kind}`, { receipt: receipt.id, ok: receipt.ok, pages });
  });
  return receipt;
}

/** The customer's copy, taken while the brain runs. It never authorises a delete. */
export async function exportTenant(ctx: ExportContext, id: string, outDir: string): Promise<ExportReceipt> {
  const t = await requireTenant(ctx.control, id);
  if (t.status === "deleted" || t.status === "provisioning") {
    throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}; there is nothing to export`);
  }
  return exportInto(ctx, t, outDir, "live");
}

/** Close the tenant database to every writer: no LOGIN, no CONNECT, no open session. */
async function fence(ctx: ExportContext, t: TenantRow): Promise<string> {
  const n = tenantNames(t.id);
  const fenceId = randomUUID();
  await withTenantLock(ctx.control, t.id, async (tx) => {
    const now = await requireTenant(tx, t.id);
    if (now.status !== t.status || now.fenceId !== t.fenceId) {
      throw new TenantError("wrong_state", `tenant '${t.id}' changed while it was being fenced; run the command again`);
    }
    await tx.query(
      `UPDATE tenants SET status = 'deleting', mode = NULL, fence_id = $2, delete_after = NULL, updated_at = now() WHERE id = $1`,
      [t.id, fenceId],
    );
    await logTenantEvent(tx, t.id, "fence", { fence: fenceId });
  });
  // The owner could otherwise log in to any other database and grant itself
  // CONNECT back: database privileges are cluster-wide.
  // The master keeps its own CONNECT: on RDS it reaches the database only
  // through the owner role it is a member of, which is about to lose it.
  await ctx.control.query(`GRANT CONNECT ON DATABASE ${ident(n.db)} TO CURRENT_USER`);
  await ctx.control.query(`ALTER ROLE ${ident(n.owner)} NOLOGIN`);
  await ctx.control.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(n.db)} FROM ${ident(n.owner)}, PUBLIC`);
  await ctx.control.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [n.db],
  );
  return fenceId;
}

export interface DeleteResult {
  receipt: ExportReceipt;
  deleteAfter: Date;
}

/**
 * Fence, export under the fence, record the receipt, and leave the tenant in
 * `deleting` for the window. Nothing is dropped here.
 */
export async function deleteTenant(ctx: ExportContext, id: string, confirm: string, outDir: string): Promise<DeleteResult> {
  const t = await requireTenant(ctx.control, id);
  if (confirm !== id) throw new TenantError("wrong_state", `--confirm must repeat the tenant id '${id}'`);
  if (t.status !== "active" && t.status !== "suspended" && t.status !== "deleting") {
    throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}; it cannot be deleted`);
  }
  if (t.status === "deleting" && t.deleteAfter !== null) {
    throw new TenantError("wrong_state", `tenant '${id}' is already waiting for deletion until ${t.deleteAfter.toISOString()}`);
  }
  const fenceId = await fence(ctx, t);
  const receipt = await exportInto(ctx, { ...t, fenceId, status: "deleting" }, outDir, "fenced");
  if (!receipt.ok) {
    throw new TenantError("no_receipt", `the export under the fence did not verify (${receipt.failures.map((f) => f.table).join(", ")}); the tenant stays fenced`);
  }
  const deleteAfter = new Date(Date.now() + DELETE_WINDOW_DAYS * 86_400_000);
  await ctx.control.transaction(async (tx) => {
    const r = await tx.query(
      `UPDATE tenants SET delete_after = $3, updated_at = now() WHERE id = $1 AND status = 'deleting' AND fence_id = $2 RETURNING id`,
      [id, fenceId, deleteAfter.toISOString()],
    );
    if (r.rows.length === 0) throw new TenantError("wrong_state", `tenant '${id}' changed while it was being exported`);
    await logTenantEvent(tx, id, "delete_scheduled", { fence: fenceId, receipt: receipt.id, delete_after: deleteAfter.toISOString() });
  });
  return { receipt, deleteAfter };
}

/** Lift the fence of a tenant waiting for deletion; its receipts stop counting. */
export async function cancelDelete(ctx: ExportContext, id: string): Promise<TenantRow> {
  // The status flips under the lifecycle lock first, so a purge that already
  // claimed the tenant wins and this refuses; only then is the fence lifted.
  await withTenantLock(ctx.control, id, async (tx) => {
    const t = await requireTenant(tx, id);
    if (t.status !== "deleting") throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}, not waiting for deletion`);
    await tx.query(
      `UPDATE tenants SET status = 'active', mode = NULL, fence_id = $2, delete_after = NULL, updated_at = now() WHERE id = $1`,
      [id, randomUUID()],
    );
    await logTenantEvent(tx, id, "delete_cancelled");
  });
  const n = tenantNames(id);
  await ctx.control.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${ident(n.db)} TO ${ident(n.owner)}`);
  await ctx.control.query(`ALTER ROLE ${ident(n.owner)} LOGIN`);
  return requireTenant(ctx.control, id);
}

/** The good fenced receipt taken under the tenant's current fence, or null. */
export async function currentReceipt(control: Engine, t: TenantRow): Promise<{ id: string } | null> {
  if (t.fenceId === null) return null;
  const r = await control.query<{ id: string }>(
    `SELECT id FROM tenant_exports WHERE tenant_id = $1 AND kind = 'fenced' AND ok AND fence_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [t.id, t.fenceId],
  );
  return r.rows[0] ?? null;
}

export interface PurgeOptions {
  now?: Date;
  /** Removes the tenant's secrets from the secret store, when the backend can. */
  removeSecrets?: (tenantId: string) => Promise<void>;
}

/**
 * Drop the database and roles of every tenant whose window has passed and
 * whose current fence has a good receipt. Each tenant is claimed first, under
 * its lifecycle lock: checked again and marked `deleted`, so a delete
 * cancelled at the same moment either wins (nothing is dropped) or is refused.
 * A purge that stopped after the claim is finished by the next run. Returns
 * the ids purged; a tenant without such a receipt is named in `skipped`.
 */
export async function purgeDeleted(ctx: ExportContext, opts: PurgeOptions = {}): Promise<{ purged: string[]; skipped: { id: string; why: string }[] }> {
  const now = opts.now ?? new Date();
  const due = (await ctx.control.query<{ id: string }>(
    `SELECT id FROM tenants WHERE status = 'deleting' AND delete_after IS NOT NULL AND delete_after <= $1 ORDER BY id`,
    [now.toISOString()],
  )).rows;
  const purged: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  const controlDb = decodeURIComponent(new URL(ctx.masterUrl).pathname.slice(1));
  const unfinished = (await ctx.control.query<{ id: string }>(
    `SELECT t.id FROM tenants t
      WHERE t.status = 'deleted'
        AND (EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = t.db_name)
             OR EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname IN (t.owner_role, t.ctl_role)))
      ORDER BY t.id`,
  )).rows.map((r) => r.id);
  const claimed: string[] = [...unfinished];
  for (const { id } of due) {
    const why = await withTenantLock(ctx.control, id, async (tx) => {
      const t = await requireTenant(tx, id);
      if (t.status !== "deleting" || t.deleteAfter === null || t.deleteAfter > now) return "no longer due for deletion";
      if (!(await currentReceipt(tx, t))) return "no good export receipt under the current fence";
      await tx.query(`UPDATE tenants SET status = 'deleted', updated_at = now() WHERE id = $1`, [id]);
      await logTenantEvent(tx, id, "purge_claimed", { fence: t.fenceId });
      return null;
    });
    if (why) skipped.push({ id, why });
    else claimed.push(id);
  }
  for (const id of claimed) {
    const n = tenantNames(id);
    await ctx.control.query(`DROP DATABASE IF EXISTS ${ident(n.db)} WITH (FORCE)`);
    for (const role of [n.owner, n.ctl]) {
      const has = await ctx.control.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (has.rows.length === 0) continue;
      await ctx.control.query(`REVOKE ALL ON DATABASE ${ident(controlDb)} FROM ${ident(role)}`);
      await ctx.control.query(`DROP OWNED BY ${ident(role)}`);
      await ctx.control.query(`DROP ROLE ${ident(role)}`);
    }
    await opts.removeSecrets?.(id);
    await ctx.control.transaction(async (tx) => {
      await tx.query(`DELETE FROM tenant_isolation WHERE tenant_id = $1`, [id]);
      await logTenantEvent(tx, id, "purged");
    });
    purged.push(id);
  }
  return { purged, skipped };
}
