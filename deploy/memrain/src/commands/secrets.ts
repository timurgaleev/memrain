/**
 * `memrain secrets audit` — scan text already stored in the brain with the
 * current secret-scanner rules (core/secret-audit.ts).
 *
 *   secrets audit [--source ID] [--kinds pages,chunks,…] [--limit N] [--json]
 *         dry run: lists every hit by store, row, field, kind, fingerprint and
 *         line. Never prints a value or a preview.
 *   secrets audit --apply --yes [--source ID] [--kinds …]
 *         rewrites what it finds (pages through a new version and a re-mirror,
 *         other supported stores in place). Job payloads are count-only and
 *         never rewritten. `--apply` without `--yes` refuses.
 *
 * Exit status: 0 when nothing was found (or everything found was rewritten),
 * 1 when hits remain, 2 on a usage error.
 */
import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { withStorage } from "./with-storage.ts";
import { AUDIT_STORES, auditStoredSecrets, isAuditStore, type AuditStore, type SecretAuditResult } from "../core/secret-audit.ts";

export interface SecretsAuditCmdOptions {
  sourceId?: string;
  kinds?: string[];
  apply?: boolean;
  yes?: boolean;
  limit?: number;
  json?: boolean;
  configPath?: string;
  /** Test seam: a storage the caller owns. */
  storage?: Storage;
}

function printHuman(r: SecretAuditResult): void {
  const mode = r.applied ? "apply" : "dry run";
  console.log(
    `secrets audit (${mode}, scanner v${r.scan_version}): ${r.rows_scanned} row(s) scanned, ` +
      `${r.rows_affected} with a hit, ${r.hits_total} hit(s).`,
  );
  if (r.skipped_kinds.length > 0) {
    console.log(`  not scanned under --source (no source column): ${r.skipped_kinds.join(", ")}`);
  }
  for (const [kind, n] of Object.entries(r.by_kind)) console.log(`  ${kind}: ${n}`);
  if (r.kinds.includes("jobs")) {
    console.log(`  jobs: count-only; ${r.jobs.rows_scanned} payload(s) scanned, ${r.jobs.hits_total} hit(s); no payloads rewritten`);
    for (const [status, n] of Object.entries(r.jobs.by_status)) console.log(`    ${status}: ${n} hit(s)`);
    for (const [kind, n] of Object.entries(r.jobs.by_secret_kind)) console.log(`    ${kind}: ${n} hit(s)`);
  }
  if (r.code_chunks_affected > 0) {
    console.log(`  code chunks with a hit: ${r.code_chunks_affected} (reindex the code source after --apply)`);
  }
  for (const h of r.hits) {
    console.log(`  ${h.kind} ${h.ref} ${h.field}${h.line !== null ? `:${h.line}` : ""} ${h.secret_kind}:${h.fingerprint}`);
  }
  if (r.hits_truncated) console.log(`  … more hits not listed (raise --limit)`);
  if (r.applied) console.log(`Rewrote ${r.rows_rewritten} row(s).`);
  if (r.mirror_failed > 0) {
    console.log(`  ${r.mirror_failed} rewritten page(s) whose search mirror failed; run the audit again`);
  }
  for (const e of r.errors) console.log(`  not rewritten: ${e}`);
  for (const c of r.key_collisions) {
    console.log(`  ${c.kind} ${c.ref} ${c.field}: a redacted key matched an existing key; kept both (suffix ~n)`);
  }
  if (!r.applied && r.hits_total > 0) {
    console.log("Rotate exposed credentials first. --apply --yes redacts supported stores; job payloads remain count-only.");
  }
}

export async function runSecretsAudit(opts: SecretsAuditCmdOptions): Promise<number> {
  if (opts.apply && !opts.yes) {
    console.error("memrain secrets audit: --apply rewrites stored rows; add --yes to confirm (run without --apply first to review)");
    return 2;
  }
  const kinds: AuditStore[] = [];
  for (const k of opts.kinds ?? []) {
    if (!isAuditStore(k)) {
      console.error(`memrain secrets audit: unknown kind '${k}' (one of: ${AUDIT_STORES.join(", ")})`);
      return 2;
    }
    kinds.push(k);
  }
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(
    storage,
    async () => {
      const r = await auditStoredSecrets(storage, {
        ...(opts.sourceId !== undefined ? { sourceId: opts.sourceId } : {}),
        ...(kinds.length > 0 ? { kinds } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        apply: opts.apply === true,
      });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else printHuman(r);
      const remaining = r.applied ? r.errors.length + r.mirror_failed : r.hits_total;
      return remaining > 0 ? 1 : 0;
    },
    { owned: opts.storage === undefined },
  );
}

export interface SecretStoreCmdOptions {
  sub: "originals" | "reveal" | "restore" | "backup" | "restore-backup";
  args: string[];
  sourceId?: string;
  slug?: string;
  apply?: boolean;
  expect?: string;
  dir?: string;
  json?: boolean;
  configPath?: string;
  /** Test seam: a storage the caller owns. */
  storage?: Storage;
}

/** Fixed vault and operation messages; never a value. */
function storeError(sub: string, e: unknown, json: boolean | undefined): number {
  const code = (e as { code?: string }).code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === undefined) throw e;
  if (json) console.log(JSON.stringify({ ok: false, code, error: message }));
  else console.error(`memrain secrets ${sub}: ${message}`);
  return 1;
}

/**
 * The secret store, on the brain host (trusted local CLI):
 *   secrets originals [--slug S] [--source ID] [--json]   what is kept, never a value
 *   secrets reveal <slug> <fingerprint> [--json]          the original behind a marker (audited)
 *   secrets restore <slug> <fingerprint>                  preview putting a false positive back
 *   secrets restore <slug> <fingerprint> --apply --plan-hash <hash>
 *   secrets backup [--dir D]                              encrypted export, mode 0600
 *   secrets restore-backup <file>                         import what the store does not hold
 */
export async function runSecretStore(opts: SecretStoreCmdOptions): Promise<number> {
  const store = await import("../core/secret-store.ts");
  const backup = await import("../core/secret-store-backup.ts");
  const out = (value: unknown, human: string): void => {
    console.log(opts.json ? JSON.stringify(value, null, 2) : human);
  };
  const [first, second] = opts.args;
  if ((opts.sub === "reveal" || opts.sub === "restore") && (!first || !second)) {
    console.error(`memrain secrets ${opts.sub}: <slug> <fingerprint> required`);
    return 2;
  }
  if (opts.sub === "restore-backup" && !first) {
    console.error("memrain secrets restore-backup: <file> required");
    return 2;
  }
  if (opts.sub === "restore" && opts.apply && !opts.expect) {
    console.error("memrain secrets restore: --apply needs --plan-hash <hash> from the preview");
    return 2;
  }
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    try {
      switch (opts.sub) {
        case "originals": {
          const rows = await store.listSecretOriginals(engine, {
            ...(opts.slug ? { slug: opts.slug } : {}), ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
          });
          out(rows, rows.length === 0 ? "no kept originals"
            : rows.map((r) => `${r.kind}:${r.fingerprint} ${r.status}${r.readable ? "" : " (key not loaded)"} ${r.source_id} ${r.slugs.join(",")}`).join("\n"));
          return 0;
        }
        case "reveal": {
          const r = await store.revealSecret(engine, { slug: first!, fingerprint: second! }, "local-cli");
          out(r, r.value);
          return 0;
        }
        case "restore": {
          if (!opts.apply) {
            const p = await store.previewSecretRestore(engine, { slug: first!, fingerprint: second! });
            out(p, `restore ${p.kind}:${p.fingerprint} into ${p.slug} (${p.fields.join(", ")}, version ${p.version_n})\nrun: ${p.command}`);
            return 0;
          }
          const r = await store.applySecretRestore(storage, { slug: first!, fingerprint: second!, expect: opts.expect! }, "local-cli");
          out(r, `restored ${r.fingerprint} into ${r.slug} as version ${r.version_n}; the value is now allowed in its source`);
          return 0;
        }
        case "backup": {
          const r = await backup.backupSecretStore(engine, opts.dir ? { dir: opts.dir } : {});
          out(r, `backed up ${r.entries} original(s), ${r.occurrences} place(s) to ${r.file} (key ${r.kek_id})`);
          return 0;
        }
        case "restore-backup": {
          const r = await backup.restoreSecretStoreBackup(engine, first!);
          out(r, `restored ${r.inserted} original(s) (${r.existing} already held, ${r.skipped_no_page} with no page holding the marker, `
            + `${r.unreadable} unreadable), ${r.occurrences} place(s)`);
          return 0;
        }
      }
    } catch (e) {
      return storeError(opts.sub, e, opts.json);
    }
  }, { owned: opts.storage === undefined });
}
