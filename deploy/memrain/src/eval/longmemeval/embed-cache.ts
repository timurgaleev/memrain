/**
 * A vector cache for LongMemEval runs, so a repeat retrieval-only run over the
 * same haystacks pays for no embedding at all.
 *
 * One SQLite file in the dataset cache directory (outside the repository):
 * key = sha256 of the model id and the exact text, value = the vector as
 * little-endian float64, the exact values the provider returned, so a cached
 * run ranks exactly like the paid one. A hit is served without touching the
 * provider or the spend ledger; a miss is embedded and paid as usual, then stored. A row whose
 * blob does not match its declared dimension is an integrity error, never a
 * silently wrong vector. The dataset is public, but the cache file is created
 * owner-only all the same.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class EmbedCacheIntegrityError extends Error {
  override name = "EmbedCacheIntegrityError";
}

function key(model: string, text: string): string {
  return createHash("sha256").update(model).update("\0").update(text).digest("hex");
}

export class EmbedCache {
  private readonly db: Database;
  hits = 0;
  misses = 0;

  constructor(readonly path: string) {
    const fresh = !existsSync(path);
    this.db = new Database(path);
    if (fresh) chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS embed_cache (
      key TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL
    ) WITHOUT ROWID`);
  }

  static inDir(dir: string): EmbedCache {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return new EmbedCache(join(dir, "embed-cache.sqlite"));
  }

  get(model: string, text: string): number[] | null {
    const k = key(model, text);
    const row = this.db.query<{ dims: number; vector: Uint8Array }, [string]>(
      "SELECT dims, vector FROM embed_cache WHERE key = ?",
    ).get(k);
    if (!row) {
      this.misses++;
      return null;
    }
    if (row.vector.byteLength !== row.dims * 8) {
      throw new EmbedCacheIntegrityError(`embed cache ${this.path}: row ${k} holds ${row.vector.byteLength} bytes for ${row.dims} dimensions`);
    }
    const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
    this.hits++;
    return Array.from({ length: row.dims }, (_, i) => view.getFloat64(i * 8, true));
  }

  put(model: string, text: string, vector: readonly number[]): void {
    const buf = new Uint8Array(vector.length * 8);
    const view = new DataView(buf.buffer);
    vector.forEach((v, i) => view.setFloat64(i * 8, v, true));
    this.db.query("INSERT OR REPLACE INTO embed_cache (key, model, dims, vector) VALUES (?, ?, ?, ?)")
      .run(key(model, text), model, vector.length, buf);
  }

  close(): void {
    this.db.close();
  }
}
