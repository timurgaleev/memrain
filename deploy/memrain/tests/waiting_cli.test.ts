/**
 * `memrain waiting` — the operator's list of who is waiting on whom. It
 * refuses, with the reason and the fix, when no mail, chat or calendar sync is
 * fresh: a stale list that looks clean is worse than none. The owner's
 * controls close, drop, mute and unmute by loop id; `sweep` runs the sweep now.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { renderMailThread } from "../src/core/connectors/render.ts";
import { recordLoopThread } from "../src/core/loops/store.ts";
import { runWaiting } from "../src/commands/waiting.ts";

const H = 3_600_000;
const NOW = new Date("2026-11-15T12:00:00Z");
let tmp: string;
let storage: Storage;

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  return { out, err, restore: () => { console.log = log; console.error = error; } };
}

async function run(opts: Omit<Parameters<typeof runWaiting>[0], "storage" | "now">) {
  const c = capture();
  try {
    const code = await runWaiting({ ...opts, storage, now: () => NOW });
    return { code, out: c.out.join("\n"), err: c.err.join("\n") };
  } finally { c.restore(); }
}

const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-waiting-cli-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
  const page = renderMailThread({ service: "gmail", accountLabel: "me@example.com" }, {
    threadId: "t1",
    messages: [{
      id: "m1", messageIdHeader: null, subject: "Budget", from: { name: "Bob", email: "bob@example.com" }, to: [{ name: null, email: "me@example.com" }], cc: [],
      date: new Date(NOW.getTime() - 48 * H).toISOString(), bodyText: "Can you approve?", bodyHtml: null, attachments: [], listUnsubscribe: false, categories: [],
    }],
  });
  await putPage(storage, { slug: `mail/${page.slug}`, markdown_body: page.body, source_id: "mail" });
  await recordLoopThread(e, { sourceId: "mail", slug: `mail/${page.slug}`, signals: page.loop! });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("memrain waiting", () => {
  it("refuses when no mail, chat or calendar connector has synced", async () => {
    const r = await run({ sub: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no mail, chat or calendar connector has synced yet");
  });

  it("refuses when the newest sync is older than 24 hours, naming it and the fix", async () => {
    await storage.engine().query(
      `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label, enabled, status, last_success_at)
       VALUES ($1, 'mail', 'google', 'admin:operator', 'me@example.com', TRUE, 'needs_reconnect', $2)`,
      [ACCOUNT, new Date(NOW.getTime() - 30 * H).toISOString()],
    );
    const r = await run({ sub: undefined });
    expect(r.code).toBe(1);
    expect(r.err).toContain("the newest mail, chat or calendar sync is 30 h old");
    expect(r.err).toContain("mail (google): needs_reconnect");
    expect(r.err).toContain("Admin → Connections");
    // --stale shows the list anyway, marked as such.
    const stale = await run({ sub: "sweep" });
    expect(stale.code).toBe(0);
    const forced = await run({ sub: undefined, stale: true, json: true });
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.out)).toMatchObject({ ok: true, stale: true });
  });

  it("lists open loops once a sync is fresh", async () => {
    await storage.engine().query(`UPDATE connector_accounts SET status = 'active', last_success_at = $1`, [new Date(NOW.getTime() - H).toISOString()]);
    const r = await run({ sub: undefined, json: true });
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as { ok: boolean; stale: boolean; loops: Array<{ id: number; loop_type: string; summary: string }> };
    expect(body.stale).toBe(false);
    expect(body.loops.map(l => l.loop_type)).toEqual(["unanswered_inbound"]);
    expect(body.loops[0]!.summary).toBe(`Reply owed to Bob <bob@example.com>: "Budget"`);
    const text = await run({ sub: undefined });
    expect(text.out).toContain("Reply owed to Bob <bob@example.com>");
  });

  it("mutes, unmutes, drops and refuses unknown ids", async () => {
    const [loop] = (JSON.parse((await run({ sub: undefined, json: true })).out) as { loops: Array<{ id: number }> }).loops;
    expect((await run({ sub: "mute", target: "sender", id: String(loop!.id) })).code).toBe(0);
    expect((await storage.engine().query(`SELECT kind FROM loop_suppressions`)).rows).toEqual([{ kind: "sender" }]);
    expect((await run({ sub: "unmute", target: "sender", id: String(loop!.id) })).code).toBe(0);
    expect((await run({ sub: "mute", target: "everyone", id: String(loop!.id) })).code).toBe(1);
    expect((await run({ sub: "drop", id: String(loop!.id) })).code).toBe(0);
    expect((JSON.parse((await run({ sub: undefined, json: true })).out) as { loops: unknown[] }).loops).toEqual([]);
    const again = await run({ sub: "done", id: String(loop!.id) });
    expect(again.code).toBe(1);
    expect(again.err).toContain(`no open loop ${loop!.id}`);
    expect((await run({ sub: "done", id: "abc" })).code).toBe(1);
  });
});
