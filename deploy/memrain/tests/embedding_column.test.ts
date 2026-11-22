import { describe, expect, it } from "bun:test";
import {
  embeddingCast,
  embeddingVectorType,
  forgetEmbeddingVectorType,
  parseEmbeddingVectorType,
} from "../src/core/embedding-column.ts";
import type { Engine, QueryResult } from "../src/core/engine/interface.ts";

/** An engine whose catalog probe answers `formatted` (or throws), counting probes. */
function fakeEngine(answer: () => string | null | Error, root?: Engine): Engine & { probes: number } {
  const e = {
    kind: "postgres" as const,
    root,
    probes: 0,
    async ready() {},
    async query<T>(): Promise<QueryResult<T>> {
      e.probes++;
      const a = answer();
      if (a instanceof Error) throw a;
      return { rows: (a === null ? [] : [{ formatted: a }]) as T[] };
    },
    async exec() {},
    async close() {},
    async transaction<T>(fn: (tx: Engine) => Promise<T>): Promise<T> {
      return fn(e);
    },
  };
  return e;
}

describe("parseEmbeddingVectorType", () => {
  // Value: protects=the column type is read exactly; fails_when=a loose match calls halfvec "vector" or the
  // reverse, binding every query with the wrong cast.
  it("tells halfvec from vector and rejects anything else", () => {
    expect(parseEmbeddingVectorType("halfvec(1024)")).toBe("halfvec");
    expect(parseEmbeddingVectorType("vector(1024)")).toBe("vector");
    expect(parseEmbeddingVectorType("vector")).toBe("vector");
    expect(parseEmbeddingVectorType("sparsevec(1024)")).toBeNull();
    expect(parseEmbeddingVectorType("text")).toBeNull();
    expect(parseEmbeddingVectorType(null)).toBeNull();
  });
});

describe("embeddingCast", () => {
  // Value: protects=binds match the live column and the catalog is read once per engine; fails_when=the cast
  // ignores the column, re-probes on every query, or a transaction handle probes on its own.
  it("follows the column, once per root engine, shared by transaction handles", async () => {
    const pool = fakeEngine(() => "halfvec(1024)");
    const tx = fakeEngine(() => "vector(1024)", pool);
    expect(await embeddingCast(pool)).toBe("::halfvec");
    expect(await embeddingCast(pool)).toBe("::halfvec");
    expect(await embeddingCast(tx)).toBe("::halfvec");
    expect(pool.probes).toBe(1);
    expect(tx.probes).toBe(0);

    const plain = fakeEngine(() => "vector(1024)");
    expect(await embeddingCast(plain)).toBe("::vector");
  });

  // Value: protects=a migration that changes the column is picked up; fails_when=the cached answer outlives
  // the migration that changed the column.
  it("re-reads the catalog after forget", async () => {
    let col = "vector(1024)";
    const e = fakeEngine(() => col);
    expect(await embeddingVectorType(e)).toBe("vector");
    col = "halfvec(1024)";
    expect(await embeddingVectorType(e)).toBe("vector");
    forgetEmbeddingVectorType(e);
    expect(await embeddingVectorType(e)).toBe("halfvec");
    expect(e.probes).toBe(2);
  });

  // Value: protects=a failed or premature probe falls back to vector without pinning it; fails_when=one
  // connection blip or an unmigrated database fixes the cast at "vector" until a restart.
  it("falls back to vector on a failed or empty probe without caching it", async () => {
    let answer: string | null | Error = new Error("connection reset");
    const e = fakeEngine(() => answer);
    expect(await embeddingCast(e)).toBe("::vector");
    answer = null;
    expect(await embeddingCast(e)).toBe("::vector");
    answer = "halfvec(1024)";
    expect(await embeddingCast(e)).toBe("::halfvec");
    expect(e.probes).toBe(3);
  });
});
