/**
 * `memrain hnsw <status|sweep|rebuild>` — manual HNSW index lifecycle ops over
 * `core/vector-index.ts`; the recovery path for an index left invalid by an
 * aborted build or an OOM mid-build. `rebuild` drops and rebuilds the
 * embeddings index in one transaction (not CONCURRENTLY): vector search waits
 * for the build, keyword search keeps serving. status/sweep are Postgres-only.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { withDirectEngine } from "../core/engine/direct.ts";
import { checkInvalidIndexes } from "../core/doctor-ops.ts";
import {
  EMBEDDINGS_HNSW_INDEX,
  embeddingsHnswSpec,
  checkActiveBuild,
  dropZombieIndexes,
  dropAndRebuild,
} from "../core/vector-index.ts";
import { embeddingVectorType } from "../core/embedding-column.ts";

export interface HnswOptions {
  force?: boolean;
}

export async function runHnsw(
  sub: string,
  opts: HnswOptions = {},
): Promise<void> {
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    const engine = storage.engine();
    switch (sub) {
      case "status": {
        const active = await checkActiveBuild(engine, EMBEDDINGS_HNSW_INDEX);
        const invalid = await checkInvalidIndexes(engine);
        console.log(
          JSON.stringify(
            {
              engine: engine.kind,
              index: EMBEDDINGS_HNSW_INDEX,
              active_build: active,
              invalid_indexes: invalid,
            },
            null,
            2,
          ),
        );
        break;
      }
      case "sweep": {
        const { dropped } = await withDirectEngine(engine, dropZombieIndexes);
        console.log(
          dropped.length === 0
            ? "hnsw sweep: no invalid indexes to drop"
            : `hnsw sweep: dropped ${dropped.length} invalid index(es): ${dropped.join(", ")}`,
        );
        break;
      }
      case "rebuild": {
        const res = await withDirectEngine(engine, async (direct) => dropAndRebuild(direct, embeddingsHnswSpec(await embeddingVectorType(direct)), {
          reason: "cli",
          force: opts.force ?? false,
        }));
        console.log(
          res.rebuilt
            ? `hnsw rebuild: ${EMBEDDINGS_HNSW_INDEX} rebuilt`
            : `hnsw rebuild: skipped (an active build is in flight — pass --force)`,
        );
        break;
      }
      default:
        throw new Error(
          `memrain hnsw: unknown subcommand '${sub}' (expected status|sweep|rebuild)`,
        );
    }
  });
}
