/**
 * A paid daemon's run under the spend wallet.
 *
 * Locks: a paid daemon's run refuses before its handler while
 * MEMRAIN_DAILY_BUDGET_USD is unset; with it set, the handler runs inside the
 * daemon's wallet path (a new paid path, keyed by daemon and source); and the
 * caps resolve from the environment and the spec's defaults, with a
 * daemon_controls row only ever lowering them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import { _resetDaemonsForTesting, registerDaemon, type DaemonSpec } from "../src/core/daemons/registry.ts";
import { registerDaemonHandler } from "../src/core/daemons/scheduler.ts";
import { resolveDaemonCaps } from "../src/core/daemons/caps.ts";
import { CONNECTOR_SYNC_DAEMON } from "../src/core/connectors/sync-daemon.ts";
import { currentWalletPath, type WalletPath } from "../src/core/budget.ts";
import type { JobRow } from "../src/core/jobs/types.ts";

const ON = { MEMRAIN_DAEMONS: "1" } as NodeJS.ProcessEnv;
const paidProbe = (over: Partial<DaemonSpec> = {}): DaemonSpec => ({
  name: "paid_probe",
  kind: "daemon_paid_probe",
  schedule: { cron: "0 7 * * *" },
  lane: "short",
  paid: true,
  defaultEnabled: true,
  defaultCapUsdPerDay: 2,
  defaultCapUsdPerRun: 0.5,
  ...over,
});
const JOB = {} as JobRow;

afterEach(() => {
  _resetDaemonsForTesting();
  _resetHandlersForTesting();
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`daemon wallet caps (${name})`, () => {
  it("refuses a paid daemon's run before its handler while the brain has no daily cap", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const spec = paidProbe();
      registerDaemon(spec);
      let ran = 0;
      registerDaemonHandler(e, spec, async () => { ran++; return {}; }, { env: ON });
      expect(await getHandler(spec.kind)!({ sourceId: "default" }, { job: JOB })).toEqual({ skipped: "no_brain_cap" });
      expect(ran).toBe(0);
    } finally { await db.close(); }
  });

  it("runs a paid daemon's handler inside its wallet path", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const spec = paidProbe();
      registerDaemon(spec);
      let seen: WalletPath | null = null;
      registerDaemonHandler(e, spec, async () => { seen = currentWalletPath(); return {}; },
        { env: { ...ON, MEMRAIN_DAILY_BUDGET_USD: "10" } });
      await getHandler(spec.kind)!({ sourceId: "src-a" }, { job: JOB });
      expect(seen).toEqual({
        role: "paid_probe",
        requiresBrainCap: true,
        runCapUsd: 0.5,
        daemon: { name: "paid_probe", sourceId: "src-a", dayCapUsd: 2, sourceDayCapUsd: null },
      });
    } finally { await db.close(); }
  });

  it("leaves a free daemon's handler outside the wallet", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const spec = paidProbe({ name: "free_probe", kind: "daemon_free_probe", paid: false });
      registerDaemon(spec);
      let seen: WalletPath | null | undefined;
      registerDaemonHandler(e, spec, async () => { seen = currentWalletPath(); return {}; }, { env: ON });
      await getHandler(spec.kind)!({ sourceId: "default" }, { job: JOB });
      expect(seen).toBeNull();
    } finally { await db.close(); }
  });

  it("resolves caps from env and spec defaults; a control row only lowers them", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const spec = paidProbe();
      expect(await resolveDaemonCaps(e, spec, "s1", {})).toEqual({ dayCapUsd: 2, sourceDayCapUsd: null, runCapUsd: 0.5 });
      const env = { MEMRAIN_DAEMON_PAID_PROBE_MAX_USD_PER_DAY: "4", MEMRAIN_DAEMON_PAID_PROBE_MAX_USD_PER_RUN: "1" };
      expect(await resolveDaemonCaps(e, spec, "s1", env)).toEqual({ dayCapUsd: 4, sourceDayCapUsd: null, runCapUsd: 1 });
      await e.query(`INSERT INTO daemon_controls (daemon, source_id, cap_usd_per_day, cap_usd_per_run) VALUES ('paid_probe', '*', 3, 9)`);
      await e.query(`INSERT INTO daemon_controls (daemon, source_id, cap_usd_per_day, cap_usd_per_run) VALUES ('paid_probe', 's1', 0.25, 0.1)`);
      expect(await resolveDaemonCaps(e, spec, "s1", env)).toEqual({ dayCapUsd: 3, sourceDayCapUsd: 0.25, runCapUsd: 0.1 });
      expect(await resolveDaemonCaps(e, spec, "s2", env)).toEqual({ dayCapUsd: 3, sourceDayCapUsd: null, runCapUsd: 1 });
    } finally { await db.close(); }
  });

  it("caps connector sync at $5 a day across every account by default", async () => {
    const db = await open();
    try {
      expect(await resolveDaemonCaps(db.storage.engine(), CONNECTOR_SYNC_DAEMON, "s1", {}))
        .toEqual({ dayCapUsd: 5, sourceDayCapUsd: null, runCapUsd: null });
    } finally { await db.close(); }
  });
});
