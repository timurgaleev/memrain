/**
 * The storage type of `embeddings.vector`: `halfvec(N)` where pgvector has it
 * (>= 0.7, migration 191), `vector(N)` otherwise. halfvec stores 2 bytes per
 * dimension instead of 4, which halves the table and its HNSW index — the
 * difference between an index that fits a small instance's cache and one read
 * from disk on every search.
 *
 * Every SQL that binds a vector against that column, or names its operator
 * class, asks here instead of spelling `::vector`. The type is read from the
 * catalog once per engine and cached; a transaction handle shares its pool
 * engine's answer through `Engine.root`.
 *
 * Binding `::vector` against a halfvec column still works (pgvector's implicit
 * vector -> halfvec cast keeps the index usable), so a stale answer degrades
 * nothing; matching the column exactly keeps the plan and the value honest.
 */
import type { Engine } from "./engine/interface.ts";

export type EmbeddingVectorType = "vector" | "halfvec";

const resolved = new WeakMap<Engine, Promise<EmbeddingVectorType>>();

function rootOf(engine: Engine): Engine {
  let e = engine;
  while (e.root && e.root !== e) e = e.root;
  return e;
}

/** `vector` or `halfvec` from a `format_type(...)` string; null when neither. */
export function parseEmbeddingVectorType(formatted: string | null | undefined): EmbeddingVectorType | null {
  if (!formatted) return null;
  if (/^halfvec(?:\(\d+\))?$/i.test(formatted.trim())) return "halfvec";
  if (/^vector(?:\(\d+\))?$/i.test(formatted.trim())) return "vector";
  return null;
}

/** The column type of `embeddings.vector`, read once per engine. Never throws. */
export function embeddingVectorType(engine: Engine): Promise<EmbeddingVectorType> {
  const root = rootOf(engine);
  let p = resolved.get(root);
  if (p === undefined) {
    p = engine
      .query<{ formatted: string | null }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass('embeddings')
            AND a.attname = 'vector'
            AND NOT a.attisdropped`,
      )
      .then((r) => {
        const t = parseEmbeddingVectorType(r.rows[0]?.formatted);
        // No table yet (an unmigrated database) is not an answer to keep.
        if (t === null) resolved.delete(root);
        return t ?? "vector";
      })
      .catch(() => {
        // A failed read is not an answer: the next caller asks again rather
        // than one connection blip pinning the default until a restart.
        resolved.delete(root);
        return "vector" as const;
      });
    resolved.set(root, p);
  }
  return p;
}

/** The bind cast for a vector compared with or written to `embeddings.vector`. */
export async function embeddingCast(engine: Engine): Promise<"::vector" | "::halfvec"> {
  return (await embeddingVectorType(engine)) === "halfvec" ? "::halfvec" : "::vector";
}

/** Drop the cached type, so the next caller reads the catalog (after a migration changed it). */
export function forgetEmbeddingVectorType(engine: Engine): void {
  resolved.delete(rootOf(engine));
}
