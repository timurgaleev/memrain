import { Worker } from "node:worker_threads";

export function eventLoopWatchdogMs(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.MEMRAIN_EVENT_LOOP_WATCHDOG_MS?.trim();
  if (!raw) return undefined;
  const ms = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(ms) || ms < 15000) {
    throw new Error("MEMRAIN_EVENT_LOOP_WATCHDOG_MS must be an integer of at least 15000 milliseconds");
  }
  return ms;
}

export function startEventLoopWatchdog(timeoutMs: number | undefined): { stop(): void } {
  if (timeoutMs === undefined) return { stop() {} };
  eventLoopWatchdogMs({ MEMRAIN_EVENT_LOOP_WATCHDOG_MS: String(timeoutMs) });
  const shared = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT * 3);
  const heartbeat = new BigInt64Array(shared);
  const worker = new Worker(new URL("./event-loop-watchdog-worker.ts", import.meta.url), { workerData: { shared, timeoutMs, pid: process.pid } });
  const timer = setInterval(() => {
    Atomics.store(heartbeat, 0, process.hrtime.bigint() / 1000000n);
    Atomics.add(heartbeat, 1, 1n);
  }, 1000);
  timer.unref();
  worker.unref();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    Atomics.store(heartbeat, 2, 1n);
    clearInterval(timer);
    void worker.terminate();
  };
  worker.on("error", () => { console.error("[memrain] event loop watchdog failed; observer stopped"); stop(); });
  return { stop };
}
