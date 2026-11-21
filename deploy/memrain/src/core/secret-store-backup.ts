/**
 * Encrypted backups of the secret store.
 *
 * The store lives in the brain's database, so every database backup already
 * carries it. `memrain secrets backup` also writes one encrypted export to
 * the config directory (`<config dir>/secret-store/backups/`, mode 0600):
 * every entry row as stored (already sealed, never a value) and its places,
 * as one JSON document sealed again with AES-256-GCM under the connector key,
 * so no slug, fingerprint or kind is in clear in the file. The key never goes
 * into it: a backup restores only where the same key is loaded.
 *
 * A restore writes entries the store does not hold, and only with the places
 * whose page is live, in the entry's source, and still holds the marker. An
 * entry with no such page is skipped, so a restore never brings back an
 * original a page purge removed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "./engine/interface.ts";
import { resolveConfigDir } from "./config.ts";
import { loadKek, unseal, VaultError, type Kek } from "./connectors/vault.ts";
import { OperationError } from "./operation-error.ts";
import { secretStoreAad } from "./secret-store.ts";

const KIND = "memrain-secret-store-backup";

export interface BackupEntryRow {
  source_id: string;
  fingerprint: string;
  kind: string;
  kek_id: string;
  nonce: string;
  ciphertext: string;
  status: "active" | "allowed";
  created_at: string;
  updated_at: string;
}

export interface BackupOccurrenceRow {
  source_id: string;
  fingerprint: string;
  slug: string;
  field: "body" | "title" | "truth";
  marker: string;
  created_at: string;
}

interface BackupDocument { kind: typeof KIND; version: 1; kek_id: string; created_at: string; nonce: string; ciphertext: string }
interface BackupBody { entries: BackupEntryRow[]; occurrences: BackupOccurrenceRow[] }

export interface BackupStatus {
  last_success: { at: string; file: string; entries: number; occurrences: number; kek_id: string; digest: string } | null;
  last_failure: { at: string; message: string } | null;
}

export const secretStoreDir = (): string => join(resolveConfigDir(), "secret-store");
export const secretStoreBackupDir = (): string => join(secretStoreDir(), "backups");
const statusFile = (): string => join(secretStoreDir(), "backup-status.json");

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readBackupStatus(): BackupStatus {
  try {
    const parsed = JSON.parse(readFileSync(statusFile(), "utf8")) as Partial<BackupStatus>;
    return { last_success: parsed.last_success ?? null, last_failure: parsed.last_failure ?? null };
  } catch {
    return { last_success: null, last_failure: null };
  }
}

function writeBackupStatus(status: BackupStatus): void {
  mkdirSync(secretStoreDir(), { recursive: true, mode: 0o700 });
  writePrivate(statusFile(), JSON.stringify(status, null, 2) + "\n");
}

const aad = (kekId: string, createdAt: string) => Buffer.from(`${KIND}:v1|${kekId}|${createdAt}`, "utf8");

/** Every entry and place, read in one statement so both come from one snapshot. */
export async function storeSnapshot(engine: Engine): Promise<BackupBody> {
  const ts = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const r = await engine.query<{ entries: string; occurrences: string }>(
    // scope: operator-only backup of the whole store
    `SELECT
       (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.source_id, e.fingerprint), '[]'::jsonb)::text FROM (
          SELECT source_id, fingerprint, kind, kek_id, nonce, ciphertext, status,
                 ${ts("created_at")} AS created_at, ${ts("updated_at")} AS updated_at FROM secret_store) e) AS entries,
       (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.source_id, o.fingerprint, o.slug, o.field, o.marker), '[]'::jsonb)::text FROM (
          SELECT s.source_id, s.fingerprint, oc.slug, oc.field, oc.marker, ${ts("oc.created_at")} AS created_at
            FROM secret_store_occurrences oc JOIN secret_store s ON s.id = oc.entry_id) o) AS occurrences`,
  );
  const row = r.rows[0]!;
  return { entries: JSON.parse(row.entries) as BackupEntryRow[], occurrences: JSON.parse(row.occurrences) as BackupOccurrenceRow[] };
}

/** A digest of the snapshot, so any change (a new place, a rename, a restore) makes the next backup due. */
function digestOf(body: BackupBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function requireKey(): Kek {
  const load = loadKek();
  if (load.kek === null) throw new VaultError("vault_no_key", `no secret store backup without a key: ${load.reason}`);
  return load.kek;
}

export interface BackupResult { file: string; entries: number; occurrences: number; kek_id: string }

/** Write one encrypted export of the whole store and record it as the last success (or the failure, then throw). */
export async function backupSecretStore(engine: Engine, opts: { dir?: string } = {}): Promise<BackupResult> {
  try {
    const kek = requireKey();
    const body = await storeSnapshot(engine);
    const createdAt = new Date().toISOString();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", kek.key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(kek.id, createdAt));
    const sealed = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final(), cipher.getAuthTag()]);
    const doc: BackupDocument = { kind: KIND, version: 1, kek_id: kek.id, created_at: createdAt, nonce: nonce.toString("base64"), ciphertext: sealed.toString("base64") };
    const dir = opts.dir ?? secretStoreBackupDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `secret-store-${createdAt.replace(/[:.]/g, "-")}.json`);
    if (existsSync(file)) throw new Error(`backup file already exists: ${file}`);
    writePrivate(file, JSON.stringify(doc) + "\n");
    const result = { file, entries: body.entries.length, occurrences: body.occurrences.length, kek_id: kek.id };
    writeBackupStatus({ last_success: { at: createdAt, ...result, digest: digestOf(body) }, last_failure: null });
    return result;
  } catch (error) {
    writeBackupStatus({ ...readBackupStatus(), last_failure: { at: new Date().toISOString(), message: (error instanceof Error ? error.message : String(error)).slice(0, 300) } });
    throw error;
  }
}

/** True when the store holds entries and no backup holds its current state. */
export async function secretStoreBackupDue(engine: Engine): Promise<boolean> {
  const body = await storeSnapshot(engine);
  if (body.entries.length === 0) return false;
  return readBackupStatus().last_success?.digest !== digestOf(body);
}

export interface RestoreBackupResult { file: string; kek_id: string; inserted: number; existing: number; skipped_no_page: number; unreadable: number; occurrences: number }

function readBackup(file: string): BackupBody & { kek_id: string } {
  let doc: BackupDocument;
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as BackupDocument;
  } catch {
    throw new OperationError("not_found", `secret store backup ${file} could not be read; nothing was restored`, "Pass a file `memrain secrets backup` wrote.");
  }
  if (doc?.kind !== KIND || doc.version !== 1) {
    throw new OperationError("invalid_params", `${file} is not a secret store backup; nothing was restored`, "Pass a file `memrain secrets backup` wrote.");
  }
  const kek = requireKey();
  if (kek.id !== doc.kek_id) throw new VaultError("vault_wrong_key", "the loaded connector key did not seal this backup; nothing was restored");
  try {
    const raw = Buffer.from(doc.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", kek.key, Buffer.from(doc.nonce, "base64"), { authTagLength: 16 });
    decipher.setAAD(aad(doc.kek_id, doc.created_at));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const body = JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8")) as BackupBody;
    return { ...body, kek_id: doc.kek_id };
  } catch {
    throw new VaultError("vault_tamper", "the secret store backup failed authentication; nothing was restored");
  }
}

/** Whether an entry row opens under the loaded key and matches its fingerprint. */
function entryOpens(row: BackupEntryRow, kek: Kek): boolean {
  try {
    const value = unseal(kek, row, secretStoreAad(row.source_id, row.fingerprint, row.kek_id));
    return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16) === row.fingerprint;
  } catch {
    return false;
  }
}

/** Import the entries of one backup the store does not hold, each only with a live page that still holds its marker. */
export async function restoreSecretStoreBackup(engine: Engine, file: string): Promise<RestoreBackupResult> {
  const body = readBackup(file);
  const kek = requireKey();
  const result: RestoreBackupResult = { file, kek_id: body.kek_id, inserted: 0, existing: 0, skipped_no_page: 0, unreadable: 0, occurrences: 0 };
  await engine.transaction(async (tx) => {
    for (const row of body.entries) {
      if (!entryOpens(row, kek)) {
        result.unreadable++;
        continue;
      }
      const places = body.occurrences.filter((o) => o.source_id === row.source_id && o.fingerprint === row.fingerprint);
      const held: BackupOccurrenceRow[] = [];
      for (const o of places) {
        const page = await tx.query<{ holds: boolean }>(
          `SELECT strpos(CASE $3::text WHEN 'body' THEN p.markdown_body WHEN 'title' THEN COALESCE(p.title, '') ELSE p.compiled_truth::text END, $4) > 0 AS holds
             FROM pages p WHERE p.slug = $1 AND p.source_id = $2 AND p.deleted_at IS NULL
              -- A page created at the slug after the place was recorded (a purge, then a new page) is not the one that held it.
              -- Milliseconds: the driver binds the timestamp at that precision.
              AND date_trunc('milliseconds', p.created_at) <= $5::timestamptz FOR SHARE`,
          [o.slug, o.source_id, o.field, o.marker, o.created_at],
        );
        if (page.rows[0]?.holds) held.push(o);
      }
      if (held.length === 0) {
        result.skipped_no_page++;
        continue;
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO secret_store (source_id, fingerprint, kind, kek_id, nonce, ciphertext, status, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz WHERE EXISTS (SELECT 1 FROM sources WHERE id = $1)
         ON CONFLICT (source_id, fingerprint) DO NOTHING RETURNING id::text AS id`,
        [row.source_id, row.fingerprint, row.kind, row.kek_id, row.nonce, row.ciphertext, row.status, row.created_at, row.updated_at],
      );
      const id = inserted.rows[0]?.id
        ?? (await tx.query<{ id: string }>(`SELECT id::text AS id FROM secret_store WHERE source_id = $1 AND fingerprint = $2`, [row.source_id, row.fingerprint])).rows[0]?.id;
      if (id === undefined) {
        result.skipped_no_page++;
        continue;
      }
      if (inserted.rows.length > 0) result.inserted++;
      else result.existing++;
      for (const o of held) {
        const r = await tx.query(
          `INSERT INTO secret_store_occurrences (entry_id, slug, field, marker, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)
           ON CONFLICT DO NOTHING RETURNING 1`,
          [id, o.slug, o.field, o.marker, o.created_at],
        );
        result.occurrences += r.rows.length;
      }
    }
  });
  if (body.entries.length > 0 && result.skipped_no_page === body.entries.length) {
    throw new OperationError("invalid_params",
      `nothing was restored from ${file}: no live page holds the marker of any of its ${body.entries.length} entr${body.entries.length === 1 ? "y" : "ies"}`,
      "The pages were purged, or are not written yet; write them, then run the same restore again.");
  }
  return result;
}
