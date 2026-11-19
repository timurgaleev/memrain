/**
 * `loops_sweep` behind the scheduler: off by default and free, registered by
 * serve's real boot path, queued per source with thread states only once the
 * operator enables it, and a run opens the loops its source holds.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { renderMailThread } from "../src/core/connectors/render.ts";
import { recordLoopThread, listLoops } from "../src/core/loops/store.ts";
import { LOOPS_SWEEP_DAEMON, LOOPS_SWEEP_JOB_KIND } from "../src/core/loops/daemon.ts";
import { registerLoopsSweepDaemon } from "../src/core/loops/job.ts";
import { _resetDaemonsForTesting, getDaemon } from "../src/core/daemons/registry.ts";
import { enqueueDueDaemons } from "../src/core/daemons/scheduler.ts";
import { _resetHandlersForTesting, getHandler } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";

const NOW = new Date("2026-11-15T12:00:00Z");

afterEach(() => {
  _resetDaemonsForTesting();
  _resetHandlersForTesting();
});

describe("loops_sweep spec", () => {
  it("is a built-in daemon, off by default, free, every 30 minutes", () => {
    expect(getDaemon("loops_sweep")).toBe(LOOPS_SWEEP_DAEMON);
    expect(LOOPS_SWEEP_DAEMON).toMatchObject({ kind: LOOPS_SWEEP_JOB_KIND, paid: false, defaultEnabled: false, lane: "short", schedule: { cron: "*/30 * * * *" } });
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`loops_sweep through the scheduler (${name})`, () => {
  it("queues only once enabled, one run per source with thread states, and the run opens its loops", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const page = renderMailThread({ service: "gmail", accountLabel: "me@example.com" }, {
        threadId: "t1",
        messages: [{
          id: "m1", messageIdHeader: null, subject: "Budget", from: { name: null, email: "bob@example.com" }, to: [{ name: null, email: "me@example.com" }], cc: [],
          date: new Date(NOW.getTime() - 48 * 3_600_000).toISOString(), bodyText: "Can you approve?", bodyHtml: null, attachments: [], listUnsubscribe: false, categories: [],
        }],
      });
      await putPage(db.storage, { slug: `mail/${page.slug}`, markdown_body: page.body, source_id: "mail" });
      await recordLoopThread(e, { sourceId: "mail", slug: `mail/${page.slug}`, signals: page.loop! });

      const env = { MEMRAIN_DAEMONS: "1" };
      registerLoopsSweepDaemon(e, { env, now: () => NOW });
      const handler = getHandler(LOOPS_SWEEP_JOB_KIND)!;
      const job = { id: "j" } as JobRow;
      expect(await handler({ daemon: "loops_sweep", sourceId: "mail", window: "w" }, { job })).toEqual({ skipped: "disabled" });
      const at = new Date("2026-11-15T12:00:30Z");
      expect((await enqueueDueDaemons(e, at, { env, log: () => {} })).find(d => d.daemon === "loops_sweep")?.outcome).toBe("disabled");

      await e.query(`INSERT INTO daemon_controls (daemon, source_id, enabled) VALUES ('loops_sweep', '*', true)`);
      const queued = (await enqueueDueDaemons(e, at, { env, log: () => {} })).filter(d => d.daemon === "loops_sweep");
      expect(queued.map(d => [d.sourceId, d.outcome])).toEqual([["mail", "queued"]]);
      const jobs = (await e.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM jobs WHERE kind = $1`, [LOOPS_SWEEP_JOB_KIND])).rows;
      expect(jobs.map(j => j.payload["sourceId"])).toEqual(["mail"]);

      expect(await handler({ daemon: "loops_sweep", sourceId: "mail", window: "w" }, { job })).toMatchObject({ threads: 1, opened: 1 });
      expect((await listLoops(e, ["mail"])).map(l => l.loop_type)).toEqual(["unanswered_inbound"]);
    } finally { await db.close(); }
  });
});
