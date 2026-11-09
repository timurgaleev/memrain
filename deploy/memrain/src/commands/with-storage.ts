/**
 * Storage lifecycle for command handlers.
 *
 * Every `memrain <cmd>` opens a Storage, does its work, and closes it. The shape
 * lives here once rather than in forty handlers, because two details of it are
 * easy to get wrong and were:
 *
 *   - `init()` runs INSIDE the try. Written as `init(); try { … } finally {
 *     close() }` a failed migration or a refused connect skips the finally
 *     entirely and strands the engine — a PGLite WASM heap or a Postgres pool
 *     for the life of the process, plus the data-directory lock, which then
 *     refuses the next open in the same process.
 *   - a `close()` that fails while the body is already failing does not
 *     replace the body's error. PGLite's `close()` throws a bare `Aborted()`
 *     when the directory never opened, and that is exactly the run where
 *     `init()`'s diagnosis ("pglite: cannot open <path> …") is the only thing
 *     that tells an operator what actually broke.
 */
import type { Storage } from "../core/storage.ts";
import { applyRuntimeEnvOverlay } from "../core/runtime-config.ts";

export interface WithStorageOptions {
  /**
   * False when the caller handed in a Storage it owns (the `opts.storage`
   * injection seam). Init and close are then the owner's business.
   */
  owned?: boolean;
  /** Pinned operator operations use an existing schema without migration or seed writes. */
  migrate?: boolean;
}

export async function withStorage<T>(
  storage: Storage,
  body: () => Promise<T>,
  opts: WithStorageOptions = {},
): Promise<T> {
  if (opts.owned === false) return body();
  let failed = false;
  try {
    if (opts.migrate === false) {
      await storage.engine().ready();
      await applyRuntimeEnvOverlay(storage.engine());
    } else await storage.init();
    return await body();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    // On the happy path a teardown failure is the only news there is, so it
    // still propagates.
    if (failed) await closeQuietly(storage);
    else await storage.close();
  }
}

/**
 * Close a storage that may never have opened, reporting rather than throwing.
 *
 * For the caller that has already failed, or has a report to print, teardown is
 * bookkeeping: PGLite's `close()` throws a bare `Aborted()` when the directory
 * never opened, and losing the diagnosis to the second symptom of the same
 * fault helps nobody.
 */
export async function closeQuietly(storage: Storage): Promise<void> {
  try {
    await storage.close();
  } catch (e) {
    console.error(
      `memrain: storage teardown failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
