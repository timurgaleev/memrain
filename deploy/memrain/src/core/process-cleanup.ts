/**
 * Process-cleanup registry.
 *
 * A registry + signal handlers so abnormal termination (SIGTERM/SIGHUP/SIGPIPE,
 * EPIPE on stdout, uncaughtException) releases held resources instead of leaking
 * them. The motivating case: a held DB lock (`db-lock.ts`) would otherwise sit
 * orphaned for up to its TTL (30 min) after a `docker compose up -d --build`
 * SIGTERMs the container mid-cycle — the next cycle then can't acquire.
 *
 * Design:
 *  - Signal scope: SIGHUP, SIGPIPE, uncaughtException, unhandledRejection, and
 *    an EPIPE-on-stdout/stderr handler. NOT SIGINT/SIGTERM — memrain's `serve`
 *    daemon already installs a graceful SIGINT/SIGTERM `shutdown()` that
 *    releases the held cycle lock (via `cycle.stop()`) before closing the
 *    engine. Registering a competing SIGTERM handler here would race that
 *    shutdown — a fast cleanup pass `process.exit()`s before the graceful drain
 *    (worker/server/storage close) finishes. So this module covers only the
 *    ABNORMAL signals where the graceful path does NOT run; the app owns the
 *    clean-cancel signals.
 *  - Idempotent: a second signal during the cleanup pass is a NO-OP. The first
 *    pass runs to its 3s deadline; a forced exit is SIGKILL.
 *  - Single ownership: `tryAcquireDbLock` auto-registers; the returned handle's
 *    `release()` deregisters. No double-register.
 *  - Best-effort: callbacks run via Promise.allSettled with a 3s deadline.
 *    Throws don't block other callbacks; a closed engine pool → the DELETE fails
 *    silently → the process exits anyway.
 *  - Normal exit path unchanged: the try/finally in the caller already releases
 *    on normal completion; deregister-before-release is atomic in
 *    single-threaded JS so there is no double-DELETE.
 */

const CLEANUP_DEADLINE_MS = 3_000;

interface CleanupEntry {
  name: string;
  fn: () => Promise<void>;
}

const registry = new Map<symbol, CleanupEntry>();
let installed = false;
let cleanupInFlight = false;

/**
 * Register a cleanup callback. Returns a deregister handle (idempotent on second
 * call). Cleanup callbacks fire on abnormal termination only; normal completion
 * uses the caller's own try/finally. Names are for diagnostic stderr output if
 * the callback throws — pick something human-readable.
 */
export function registerCleanup(name: string, fn: () => Promise<void>): () => void {
  const key = Symbol(name);
  registry.set(key, { name, fn });
  let deregistered = false;
  return () => {
    if (deregistered) return;
    deregistered = true;
    registry.delete(key);
  };
}

/** Read the currently registered cleanup count. Test seam. @internal */
export function _registeredCleanupCountForTests(): number {
  return registry.size;
}

/**
 * Manually trigger the cleanup pass + exit. Used by the EPIPE-on-stdout handler
 * so a broken pipe routes through cleanup instead of an immediate exit.
 */
export async function triggerCleanupAndExit(code: number): Promise<void> {
  await runCleanupPass();
  process.exit(code);
}

async function runCleanupPass(): Promise<void> {
  if (cleanupInFlight) return; // Idempotent: a second signal during cleanup is a NO-OP.
  cleanupInFlight = true;

  const entries = Array.from(registry.values());
  if (entries.length === 0) return;

  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(resolve, CLEANUP_DEADLINE_MS, "deadline");
  });

  const cleanupAll = Promise.allSettled(
    entries.map(async (e) => {
      try {
        await e.fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          process.stderr.write(`[process-cleanup] ${e.name}: ${msg}\n`);
        } catch {
          /* even stderr might be broken */
        }
        throw err;
      }
    }),
  );

  try {
    await Promise.race([cleanupAll, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Install signal handlers + the EPIPE-on-stdout handler. Idempotent (second call
 * is a NO-OP). Call once at startup, AFTER any existing signal handlers, so it
 * never preempts a SIGINT AbortController cancel path.
 */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;

  const handleSignal = (signal: NodeJS.Signals) => {
    void runCleanupPass().finally(() => {
      // GNU `kill` convention: 128 + signal number. The exact integer is
      // advisory; the goal is "exit promptly after cleanup".
      const code = signal === "SIGHUP" ? 129 : signal === "SIGPIPE" ? 141 : 1;
      process.exit(code);
    });
  };

  // NOT SIGTERM/SIGINT — the app owns those (see the module header). SIGHUP is
  // the abnormal terminal-hangup case; SIGPIPE is rarely raised directly (Node
  // ignores it by default and surfaces an EPIPE write error instead) but listen
  // anyway.
  process.on("SIGHUP", () => handleSignal("SIGHUP"));
  process.on("SIGPIPE", () => handleSignal("SIGPIPE"));

  process.on("uncaughtException", (err) => {
    try {
      process.stderr.write(`[uncaughtException] ${err instanceof Error ? (err.stack ?? err.message) : err}\n`);
    } catch {
      /* stderr might be broken */
    }
    void runCleanupPass().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    try {
      process.stderr.write(`[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}\n`);
    } catch {
      /* stderr might be broken */
    }
    void runCleanupPass().finally(() => process.exit(1));
  });

  // EPIPE on stdout — the canonical `<cmd> | head -N` case. Route through the
  // cleanup pass so locks release BEFORE we exit.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      void triggerCleanupAndExit(0);
    }
  });
  process.stderr.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") {
      void triggerCleanupAndExit(0);
    }
  });
}

/**
 * Test-only: reset all module state so the handler can re-install with a clean
 * slate. NEVER call from production code. @internal
 */
export function _resetForTests(): void {
  registry.clear();
  installed = false;
  cleanupInFlight = false;
}
