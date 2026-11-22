/**
 * HNSW index lifecycle manager. On PGLite every DB op is a guarded no-op
 * (single-connection, no pg_stat_activity / CONCURRENTLY), so these assert the
 * guards + the pure classifier. The real Postgres CONCURRENTLY rebuild path is
 * verified against live RDS in the ship loop.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { vectorSearch } from "../src/core/search/vector.ts";
import {
  EMBEDDINGS_HNSW_INDEX,
  embeddingsHnswSpec,
  hnswEfSearchFor,
  checkActiveBuild,
  dropZombieIndexes,
  dropAndRebuild,
  monitorBuild,
  isExternalMaintenanceBuild,
  type ActiveBuildInfo,
} from "../src/core/vector-index.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-vecidx-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("embeddingsHnswSpec", () => {
  // Value: protects=a rebuild names the opclass of the column it rebuilds; fails_when=a halfvec column
  // gets vector_cosine_ops (Postgres refuses the CREATE INDEX).
  it("targets the production index with the column's operator class", () => {
    for (const type of ["vector", "halfvec"] as const) {
      const spec = embeddingsHnswSpec(type);
      expect(spec.name).toBe(EMBEDDINGS_HNSW_INDEX);
      expect(spec.name).toBe("embeddings_vector_idx");
      expect(spec.table).toBe("embeddings");
      expect(spec.using).toBe(`hnsw (vector ${type}_cosine_ops)`);
    }
  });
});

describe("PGLite no-op guards", () => {
  it("checkActiveBuild returns inactive", async () => {
    const r = await checkActiveBuild(storage.engine(), "embeddings_vector_idx");
    expect(r.active).toBe(false);
  });

  it("dropZombieIndexes drops nothing", async () => {
    const r = await dropZombieIndexes(storage.engine());
    expect(r.dropped).toEqual([]);
  });

  it("dropAndRebuild reports not-rebuilt (postgres-only)", async () => {
    const r = await dropAndRebuild(storage.engine(), embeddingsHnswSpec("halfvec"));
    expect(r.rebuilt).toBe(false);
    expect(r.tempName).toBe("embeddings_vector_idx");
  });

  it("monitorBuild returns immediately", async () => {
    let calls = 0;
    await monitorBuild(storage.engine(), "embeddings_vector_idx", () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});

describe("isExternalMaintenanceBuild", () => {
  const build = (app: string): ActiveBuildInfo => ({
    active: true,
    pid: 1,
    application_name: app,
  });

  it("flags RDS / managed maintenance app names", () => {
    expect(isExternalMaintenanceBuild(build("rdsadmin"))).toBe(true);
    expect(isExternalMaintenanceBuild(build("autovacuum worker"))).toBe(true);
    expect(isExternalMaintenanceBuild(build("pg_cron scheduler"))).toBe(true);
  });

  it("does not flag a memex process build", () => {
    expect(isExternalMaintenanceBuild(build("memex"))).toBe(false);
  });

  it("is false when no build is active", () => {
    expect(isExternalMaintenanceBuild({ active: false })).toBe(false);
  });
});

describe("hnswEfSearchFor", () => {
  it("clamps to [40, 1000]", () => {
    expect(hnswEfSearchFor(10)).toBe(40);
    expect(hnswEfSearchFor(40)).toBe(40);
    expect(hnswEfSearchFor(60)).toBe(60);
    expect(hnswEfSearchFor(5000)).toBe(1000);
  });
});

describe("ef_search raise on the ANN arm", () => {
  it("a fanout above 40 still serves on PGLite (GUC branch is Postgres-only)", async () => {
    // On PGLite the GUC/transaction branch is deliberately skipped (single
    // connection — a tx would alias concurrent queries); the call must fall
    // through to the plain path and return the (empty) result.
    const rows = await vectorSearch(storage.engine(), new Array(1024).fill(0), 60);
    expect(rows).toEqual([]);
  });
});
