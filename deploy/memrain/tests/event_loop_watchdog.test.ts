import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { eventLoopWatchdogMs } from "../src/core/event-loop-watchdog.ts";
import { observeWatchdog, type WatchdogState } from "../src/core/event-loop-watchdog-state.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { applyRuntimeEnvOverlay, legacyKey } from "../src/core/runtime-config.ts";

it("never arms a process watchdog from a stored configuration row", async () => {
  const db = await storageEngines(undefined)[0]!.open();
  const key = "MEMRAIN_EVENT_LOOP_WATCHDOG_MS";
  const keys = [key, legacyKey(key)];
  const prior = keys.map(k => process.env[k]);
  try {
    for (const storedKey of keys) {
      for (const k of keys) delete process.env[k];
      await db.storage.engine().query("INSERT INTO runtime_config(key,value) VALUES($1,'15000')", [storedKey]);
      expect(await applyRuntimeEnvOverlay(db.storage.engine())).not.toContain(storedKey);
      expect(eventLoopWatchdogMs()).toBeUndefined();
      await db.storage.engine().exec("DELETE FROM runtime_config");
    }
  } finally {
    keys.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; });
    await db.close();
  }
});

it("arms after two observed beats and resets elapsed stall time after observer starvation", () => {
  let state: WatchdogState = { observedAt: 0, heartbeatAt: 0, sequence: 0n, beats: 0, tripped: false };
  state = observeWatchdog(state, 1000, 1000, 1n, 15000);
  expect(state.beats).toBe(1);
  state = observeWatchdog(state, 2000, 2000, 2n, 15000);
  expect(state.beats).toBe(2);
  state = observeWatchdog(state, 100000, 2000, 2n, 15000);
  expect(state.tripped).toBe(false);
  for (let now = 101000; now < 115000; now += 1000) state = observeWatchdog(state, now, 2000, 2n, 15000);
  expect(state.tripped).toBe(false);
  expect(observeWatchdog(state, 115000, 2000, 2n, 15000).tripped).toBe(true);
});

it("is off by default and refuses unsafe or malformed thresholds", () => {
  expect(eventLoopWatchdogMs({})).toBeUndefined();
  expect(eventLoopWatchdogMs({ MEMRAIN_EVENT_LOOP_WATCHDOG_MS: "" })).toBeUndefined();
  for (const value of ["0", "14999", "NaN", "15000.5", "-1", "Infinity", "1e5"]) {
    expect(() => eventLoopWatchdogMs({ MEMRAIN_EVENT_LOOP_WATCHDOG_MS: value })).toThrow("MEMRAIN_EVENT_LOOP_WATCHDOG_MS");
  }
  expect(eventLoopWatchdogMs({ MEMRAIN_EVENT_LOOP_WATCHDOG_MS: "15000" })).toBe(15000);
});

async function runChild(script: string, timeout = 30000) {
  const child = spawn(process.execPath, ["-e", `import { startEventLoopWatchdog } from ${JSON.stringify(new URL("../src/core/event-loop-watchdog.ts", import.meta.url).pathname)}; ${script}`], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    return { ...result, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); child.kill(); }
}

it("terminates the stalled process while healthy asynchronous waits survive", async () => {
  const [stalled, healthy] = await Promise.all([
    runChild('startEventLoopWatchdog(15000); process.on("SIGTERM", () => {}); await Bun.sleep(3500); while (true) {}'),
    runChild('const watchdog = startEventLoopWatchdog(15000); await Bun.sleep(18000); watchdog.stop(); console.log("healthy");'),
  ]);
  expect(stalled.signal).toBe("SIGKILL");
  expect(stalled.timedOut).toBe(false);
  expect(stalled.stderr).toContain("[memrain] event loop stalled; terminating process");
  expect(healthy.code).toBe(0);
  expect(healthy.stdout.trim()).toBe("healthy");
  expect(healthy.stderr).toBe("");
}, 35000);

it("stopping the watchdog releases its worker and heartbeat handles", async () => {
  const result = await runChild('const watchdog = startEventLoopWatchdog(15000); watchdog.stop(); watchdog.stop(); console.log("stopped");', 3000);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("stopped");
});

if (process.env.MEMRAIN_TEST_POSTGRES_URL) it("rolls back an interrupted PostgreSQL transaction and releases its advisory lock", async () => {
  const db = await storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)[1]!.open();
  try {
    const e = db.storage.engine();
    await e.exec("CREATE TABLE watchdog_probe (value text NOT NULL)");
    const database = (await e.query<{ name: string }>("SELECT current_database() AS name")).rows[0]!.name;
    const url = new URL(process.env.MEMRAIN_TEST_POSTGRES_URL!);
    url.pathname = `/${database}`;
    const script = `import { PostgresEngine } from ${JSON.stringify(new URL("../src/core/engine/postgres.ts", import.meta.url).pathname)};
      const engine = new PostgresEngine({ url: process.env.WATCHDOG_FIXTURE_URL });
      startEventLoopWatchdog(15000); process.on("SIGTERM", () => {}); await Bun.sleep(3500);
      await engine.transaction(async tx => { await tx.exec("INSERT INTO watchdog_probe VALUES ('uncommitted')");
        await tx.query("SELECT pg_advisory_xact_lock(731821)"); console.log("locked"); while (true) {} });`;
    const prior = process.env.WATCHDOG_FIXTURE_URL;
    process.env.WATCHDOG_FIXTURE_URL = url.toString();
    try {
      const result = await runChild(script);
      expect(result.timedOut).toBe(false);
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toContain("locked");
      expect((await e.query("SELECT * FROM watchdog_probe")).rows).toEqual([]);
      await e.transaction(async tx => {
        expect((await tx.query<{ available: boolean }>("SELECT pg_try_advisory_xact_lock(731821) AS available")).rows[0]!.available).toBe(true);
      });
    } finally {
      if (prior === undefined) delete process.env.WATCHDOG_FIXTURE_URL;
      else process.env.WATCHDOG_FIXTURE_URL = prior;
    }
  } finally { await db.close(); }
}, 40000);
