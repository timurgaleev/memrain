/**
 * `memrain tenant …` — the operator's control plane for a hosted install.
 *
 *   create <id> --host H [--plan personal|team] [--owner M] [--resume]
 *          [--secrets file|aws] [--secrets-dir D] [--secrets-prefix P] [--invite-out F]
 *   list [--status a,b] [--json]
 *   suspend <id> --mode block|read-only
 *   resume <id>                 a suspended tenant, or one waiting for deletion
 *   limits <id> --set k=v[,k=v] max-members, max-pages, max-usd-per-day ('none' clears)
 *   export <id> --out DIR       the customer's copy; never authorises a delete
 *   delete <id> --confirm <id> --out DIR
 *   purge-deleted               drop tenants whose window passed, with a good receipt
 *   migrate-control             apply the control database's migrations
 *   migrate <id>                apply the brain migrations to one tenant
 *   usage <id> --date YYYY-MM-DD [--out FILE]
 *   smoke-record <id> --boot-id B --image-stamp S --started-at ISO
 *   spend [--days N]
 *   cap [--usd N] [--llm-off | --llm-on]
 *
 * The control database is reached with the master role through
 * MEMRAIN_CONTROL_ADMIN_URL; that URL never goes to a tenant container. No
 * secret is printed: generated credentials go to the secret writer, and the
 * owner's invite link is printed once (or written to --invite-out, 0600).
 */
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PostgresEngine } from "../core/engine/postgres.ts";
import { runMigrations } from "../core/migrate.ts";
import { CONTROL_ADMIN_URL_ENV, renderTenantListJson, type TenantMode } from "../control/contract.ts";
import { migrateControl } from "../control/migrations.ts";
import { createTenant, urlForDatabase } from "../control/provision.ts";
import { AwsSecretWriter, FileSecretWriter } from "../control/secret-writer.ts";
import { cancelDelete, deleteTenant, exportTenant, purgeDeleted } from "../control/export.ts";
import { JsonlFileSink, noopSink, recordSmoke, setHostingCap, spendSummary, tenantUsage } from "../control/usage.ts";
import {
  TenantError,
  assertTenantId,
  ident,
  listEntry,
  listTenants,
  parseLimitAssignments,
  requireTenant,
  resumeTenant,
  setTenantLimits,
  suspendTenant,
  tenantNames,
  type TenantPlan,
  type TenantRowStatus,
} from "../control/tenants.ts";

export const TENANT_SUBCOMMANDS = [
  "create", "list", "suspend", "resume", "limits", "export", "delete", "purge-deleted",
  "migrate-control", "migrate", "usage", "smoke-record", "spend", "cap",
] as const;

const BOOLEAN_FLAGS = new Set(["json", "resume", "llm-off", "llm-on"]);

function parse(args: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 2) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = "true";
      continue;
    }
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`tenant: flag --${key} needs a value`);
    flags[key] = val;
    i++;
  }
  return { positional, flags };
}

function adminUrl(env: NodeJS.ProcessEnv): string {
  const url = env[CONTROL_ADMIN_URL_ENV]?.trim();
  if (!url) throw new Error("tenant: set MEMRAIN_CONTROL_ADMIN_URL to the master-role URL of the control database");
  return url;
}

function need(v: string | undefined, name: string, usage: string): string {
  if (v === undefined || v === "") throw new Error(`tenant: --${name} is required (${usage})`);
  return v;
}

function idArg(positional: string[], usage: string): string {
  const id = positional[1];
  if (!id) throw new Error(`Usage: memrain tenant ${usage}`);
  assertTenantId(id);
  return id;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function secretWriter(flags: Record<string, string>, env: NodeJS.ProcessEnv): FileSecretWriter | AwsSecretWriter {
  const backend = flags["secrets"] ?? "file";
  if (backend === "file") return new FileSecretWriter(flags["secrets-dir"] ?? "./tenant-secrets");
  if (backend === "aws") {
    const prefix = flags["secrets-prefix"] ?? env["SECRETS_PREFIX"] ?? "memrain";
    return new AwsSecretWriter(prefix);
  }
  throw new Error("tenant: --secrets must be 'file' or 'aws'");
}

const ACTIVE_JOB_POLL_MS = 2_000;
const SUSPEND_WAIT_MS = 60_000;

/** Wait up to a minute for the tenant's running jobs to hand themselves back; the ids still running. */
async function runningJobsAfterSuspend(masterUrl: string, db: string): Promise<string[]> {
  const brain = new PostgresEngine({ url: urlForDatabase(masterUrl, db), max: 1 });
  try {
    const deadline = Date.now() + SUSPEND_WAIT_MS;
    for (;;) {
      const r = await brain.query<{ id: string }>(`SELECT id FROM jobs WHERE status = 'running' ORDER BY id`);
      const ids = r.rows.map((x) => String(x.id));
      if (ids.length === 0 || Date.now() >= deadline) return ids;
      await new Promise((res) => setTimeout(res, ACTIVE_JOB_POLL_MS));
    }
  } finally {
    await brain.close();
  }
}

export async function runTenant(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { positional, flags } = parse(args);
  const sub = positional[0];
  if (!sub || !(TENANT_SUBCOMMANDS as readonly string[]).includes(sub)) {
    console.error(`Usage: memrain tenant <${TENANT_SUBCOMMANDS.join("|")}>`);
    return 1;
  }
  const masterUrl = adminUrl(env);
  const control = new PostgresEngine({ url: masterUrl, max: 4 });
  const ctx = { masterUrl, control };
  try {
    switch (sub) {
      case "migrate-control": {
        const r = await migrateControl(control);
        print({ ok: true, applied: r.applied, skipped: r.skipped });
        return 0;
      }
      case "list": {
        const statuses = flags["status"]?.split(",").map((s) => s.trim()).filter(Boolean) as TenantRowStatus[] | undefined;
        const rows = await listTenants(control, statuses);
        if (flags["json"]) console.log(renderTenantListJson(rows.map(listEntry)));
        else for (const t of rows) console.log(`${t.id}\t${t.status}${t.mode ? `(${t.mode})` : ""}\t${t.hostname}`);
        return 0;
      }
      case "create": {
        const id = idArg(positional, "create <id> --host <hostname>");
        const plan = (flags["plan"] ?? "personal") as TenantPlan;
        if (plan !== "personal" && plan !== "team") throw new Error("tenant: --plan must be personal or team");
        const r = await createTenant({ masterUrl, control, secrets: secretWriter(flags, env) }, {
          id,
          hostname: need(flags["host"], "host", "create <id> --host <hostname>"),
          plan,
          ...(flags["owner"] ? { ownerMember: flags["owner"] } : {}),
          ...(flags["resume"] ? { resume: true } : {}),
        });
        let invite: unknown = null;
        if (r.invite && flags["invite-out"]) {
          const target = resolve(flags["invite-out"]);
          rmSync(target, { force: true });
          writeFileSync(target, `${r.invite.url}\n`, { mode: 0o600 });
          invite = { written_to: target, expires_at: r.invite.expiresAt };
        } else if (r.invite) {
          invite = { url: r.invite.url, expires_at: r.invite.expiresAt, note: "shown once" };
        }
        print({
          ok: true,
          tenant: r.id,
          status: r.status,
          connector_client_id: r.connectorClientId,
          steps: r.ran,
          invite,
          ...(r.pending ? { pending: r.pending, note: "member invites are not available yet; rerun with --resume once they are" } : {}),
          ...(r.alreadyActive ? { note: "tenant already exists; nothing changed" } : {}),
        });
        return 0;
      }
      case "suspend": {
        const id = idArg(positional, "suspend <id> --mode block|read-only");
        const mode = need(flags["mode"], "mode", "suspend <id> --mode block|read-only") as TenantMode;
        if (mode !== "block" && mode !== "read-only") throw new Error("tenant: --mode must be block or read-only");
        const t = await suspendTenant(control, id, mode);
        const still = await runningJobsAfterSuspend(masterUrl, t.dbName);
        print({ ok: true, tenant: id, status: t.status, mode: t.mode, jobs_still_running: still });
        return 0;
      }
      case "resume": {
        const id = idArg(positional, "resume <id>");
        const t = await requireTenant(control, id);
        const after = t.status === "deleting" ? await cancelDelete(ctx, id) : await resumeTenant(control, id);
        print({ ok: true, tenant: id, status: after.status });
        return 0;
      }
      case "limits": {
        const id = idArg(positional, "limits <id> --set k=v[,k=v]");
        const t = await setTenantLimits(control, id, parseLimitAssignments(need(flags["set"], "set", "limits <id> --set k=v").split(",")));
        print({ ok: true, tenant: id, limits: t.limits });
        return 0;
      }
      case "export": {
        const id = idArg(positional, "export <id> --out DIR");
        print({ ok: true, receipt: await exportTenant(ctx, id, need(flags["out"], "out", "export <id> --out DIR")) });
        return 0;
      }
      case "delete": {
        const id = idArg(positional, "delete <id> --confirm <id> --out DIR");
        const r = await deleteTenant(ctx, id, need(flags["confirm"], "confirm", "delete <id> --confirm <id>"), need(flags["out"], "out", "delete <id> --out DIR"));
        print({ ok: true, tenant: id, receipt: r.receipt.id, export_dir: r.receipt.outDir, delete_after: r.deleteAfter.toISOString() });
        return 0;
      }
      case "purge-deleted": {
        const removeSecrets = flags["secrets"] === "aws"
          ? undefined
          : async (id: string) => rmSync(join(resolve(flags["secrets-dir"] ?? "./tenant-secrets"), id), { recursive: true, force: true });
        print({ ok: true, ...(await purgeDeleted(ctx, removeSecrets ? { removeSecrets } : {})) });
        return 0;
      }
      case "migrate": {
        const id = idArg(positional, "migrate <id>");
        const t = await requireTenant(control, id);
        if (t.status === "deleting" || t.status === "deleted") throw new TenantError("wrong_state", `tenant '${id}' is ${t.status}`);
        // The master acts as the owner role, so new objects belong to the tenant.
        const brain = new PostgresEngine({ url: urlForDatabase(masterUrl, t.dbName), max: 1 });
        try {
          await brain.query(`SET ROLE ${ident(tenantNames(id).owner)}`);
          const r = await runMigrations(brain);
          print({ ok: true, tenant: id, applied: r.applied, skipped: r.skipped });
        } finally {
          await brain.close();
        }
        return 0;
      }
      case "usage": {
        const id = idArg(positional, "usage <id> --date YYYY-MM-DD");
        const events = await tenantUsage(ctx, id, need(flags["date"], "date", "usage <id> --date YYYY-MM-DD"));
        await (flags["out"] ? new JsonlFileSink(resolve(flags["out"])) : noopSink).write(events);
        print({ ok: true, events });
        return 0;
      }
      case "smoke-record": {
        const id = idArg(positional, "smoke-record <id> --boot-id B --image-stamp S --started-at ISO");
        await recordSmoke(control, id, {
          bootId: need(flags["boot-id"], "boot-id", "smoke-record"),
          imageStamp: need(flags["image-stamp"], "image-stamp", "smoke-record"),
          startedAt: new Date(need(flags["started-at"], "started-at", "smoke-record")),
        });
        print({ ok: true, tenant: id });
        return 0;
      }
      case "spend": {
        const days = flags["days"] === undefined ? 7 : Number(flags["days"]);
        if (!Number.isInteger(days) || days < 1) throw new Error("tenant: --days must be a positive whole number");
        print({ ok: true, ...(await spendSummary(control, days)) });
        return 0;
      }
      case "cap": {
        if (flags["llm-off"] && flags["llm-on"]) throw new Error("tenant: --llm-off and --llm-on contradict each other");
        const usd = flags["usd"] === undefined ? undefined : Number(flags["usd"]);
        await setHostingCap(control, {
          ...(usd !== undefined ? { capUsd: usd } : {}),
          ...(flags["llm-off"] ? { llmOff: true } : flags["llm-on"] ? { llmOff: false } : {}),
        });
        const s = await control.query<{ cap_usd: string; llm_off: boolean }>(`SELECT cap_usd::text, llm_off FROM hosting_settings`);
        print({ ok: true, cap_usd: Number(s.rows[0]?.cap_usd), llm_off: s.rows[0]?.llm_off });
        return 0;
      }
    }
    return 1;
  } catch (err) {
    if (err instanceof TenantError) {
      console.error(`tenant ${sub}: ${err.code}: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    await control.close();
  }
}
