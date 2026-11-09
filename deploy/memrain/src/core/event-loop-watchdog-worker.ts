import { workerData } from "node:worker_threads";
import { writeSync } from "node:fs";
import { observeWatchdog, type WatchdogState } from "./event-loop-watchdog-state.ts";

const { shared, timeoutMs, pid } = workerData as { shared: SharedArrayBuffer; timeoutMs: number; pid: number };
const heartbeat = new BigInt64Array(shared);
const now = () => Number(process.hrtime.bigint() / 1000000n);
let state: WatchdogState = { observedAt: now(), heartbeatAt: now(), sequence: 0n, beats: 0, tripped: false };
const observer = setInterval(() => {
  if (Atomics.load(heartbeat, 2)) { clearInterval(observer); return; }
  state = observeWatchdog(state, now(), Number(Atomics.load(heartbeat, 0)), Atomics.load(heartbeat, 1), timeoutMs);
  if (!state.tripped) return;
  clearInterval(observer);
  writeSync(2, "[memrain] event loop stalled; terminating process\n");
  process.kill(pid, "SIGTERM");
  setTimeout(() => { if (!Atomics.load(heartbeat, 2)) process.kill(pid, "SIGKILL"); }, 5000);
}, 1000);
