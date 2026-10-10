/**
 * `memrain secrets audit` — scan text already stored in the brain with the
 * current secret-scanner rules (core/secret-audit.ts).
 *
 *   secrets audit [--source ID] [--kinds pages,chunks,…] [--limit N] [--json]
 *         dry run: lists every hit by store, row, field, kind, fingerprint and
 *         line. Never prints a value or a preview.
 *   secrets audit --apply --yes [--source ID] [--kinds …]
 *         rewrites what it finds (pages through a new version and a re-mirror,
 *         everything else in place). `--apply` without `--yes` refuses.
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
  if (r.code_chunks_affected > 0) {
    console.log(`  code chunks with a hit: ${r.code_chunks_affected} (reindex the code source after --apply)`);
  }
  for (const h of r.hits) {
    console.log(`  ${h.kind} ${h.ref} ${h.field}${h.line !== null ? `:${h.line}` : ""} ${h.secret_kind}:${h.fingerprint}`);
  }
  if (r.hits_truncated) console.log(`  … more hits not listed (raise --limit)`);
  if (r.applied) console.log(`Rewrote ${r.rows_rewritten} row(s).`);
  for (const e of r.errors) console.log(`  not rewritten: ${e}`);
  if (!r.applied && r.hits_total > 0) {
    console.log("Rotate every credential listed here first, then re-run with --apply --yes to redact the stored copies.");
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
      const remaining = r.applied ? r.errors.length : r.hits_total;
      return remaining > 0 ? 1 : 0;
    },
    { owned: opts.storage === undefined },
  );
}
