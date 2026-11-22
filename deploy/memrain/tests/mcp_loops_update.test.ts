/**
 * MCP `loops_update`: close, mute and unmute one loop, only inside the
 * caller's WRITE source. A federated read grant never reaches a loop, an
 * authenticated caller with no write source is refused even with the global
 * fail-closed flag off, and the public bearer and narrowed surfaces never see
 * the tool.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { OPERATIONS, operationAnnotations } from "../src/mcp/operations.ts";
import { visibleToolDefs } from "../src/mcp/visibility.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;
const priorFailClosed = process.env["MEMRAIN_TENANT_FAIL_CLOSED"];

/** Writes to `sourceId`, reads it plus any federated sources. */
const writer = (sourceId: string, reads: string[] = [sourceId]): AuthInfo =>
  ({ token: `tok-${sourceId}`, clientId: `client-${sourceId}`, scopes: ["read", "write"], sourceId, allowedSources: reads, isPublic: false });

const LOOP = `INSERT INTO open_loops (source_id, dedup_key, loop_type, detector, kind, thread_ref, page_slug, counterparty_label, counterparty_key, summary, opened_at, last_activity_at)
  VALUES ($1, $2, $3, 'deterministic', 'mail', $4, $5, 'Eve', $6, $7, NOW(), NOW()) RETURNING id`;

const ids: Record<string, number> = {};
const EVE = "eeeeeeeeeeeeeeee";

async function seed() {
  const e = storage.engine();
  await e.query(`DELETE FROM open_loops`);
  await e.query(`DELETE FROM loop_suppressions`);
  let n = 0;
  const add = async (name: string, source: string, type: string, key: string) => {
    const thread = (++n).toString(16).padStart(16, "0");
    const r = await e.query<{ id: number }>(LOOP, [source, name, type, thread, `${source}/thread`, key, `Reply owed to Eve: "${name}"`]);
    ids[name] = Number(r.rows[0]!.id);
  };
  await add("a1", "mail-a", "unanswered_inbound", EVE);
  await add("a2", "mail-a", "unanswered_inbound", EVE);
  await add("a-promise", "mail-a", "commitment_owed_by_me", EVE);
  await add("b1", "mail-b", "unanswered_inbound", EVE);
}

const rowOf = async (id: number) =>
  (await storage.engine().query<{ status: string; closed_by: string | null }>(`SELECT status, closed_by FROM open_loops WHERE id = $1`, [id])).rows[0];

async function call(args: Record<string, unknown>, authInfo?: AuthInfo, isPublic = false) {
  const r = await dispatchTool(storage, { name: "loops_update", arguments: args }, { ...(authInfo ? { authInfo } : {}), isPublic });
  return { r, body: JSON.parse(r.content[0]!.text) as Record<string, any> };
}

beforeAll(async () => {
  delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
  tmp = mkdtempSync(join(tmpdir(), "memrain-mcp-loops-update-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const s of ["mail-a", "mail-b"]) {
    await registerSource(storage.engine(), { id: s, kind: "mailbox", pathPrefix: `${s}/` });
    await putPage(storage, { slug: `${s}/thread`, markdown_body: "x", source_id: s });
  }
});

beforeEach(seed);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  if (priorFailClosed === undefined) delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
  else process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = priorFailClosed;
});

describe("MCP loops_update", () => {
  it("is a write tool, idempotent and not destructive, with stored text redacted on the way out", () => {
    const op = OPERATIONS.find(o => o.name === "loops_update")!;
    expect(op.scope).toBe("write");
    expect(op.outputRedaction).toBe("retrieval");
    expect(operationAnnotations(op)).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  // Value: protects=done closes one loop as the owner, once; fails_when=a closed or foreign id is rewritten.
  it("closes an open loop in the write source, and reports not_found for a closed one", async () => {
    const { body } = await call({ id: ids["a1"], action: "done" }, writer("mail-a"));
    expect(body).toMatchObject({ ok: true, loop: { id: ids["a1"], status: "done", closed_by: "owner", trust: "external" } });
    expect(body["loop"]["summary"].startsWith(`<external_content trust="external">`)).toBe(true);
    expect(body["loop"]).not.toHaveProperty("counterparty");
    const again = await call({ id: ids["a1"], action: "dropped" }, writer("mail-a"));
    expect(again.r.isError).toBe(true);
    expect(again.body["error"]).toBe("not_found");
    expect(await rowOf(ids["a1"]!)).toEqual({ status: "done", closed_by: "owner" });
  });

  // Value: protects=a federated READ grant never writes loops; fails_when=the handler scopes by the read set.
  it("cannot close or mute a loop in a source the caller only reads", async () => {
    const reader = writer("mail-a", ["mail-a", "mail-b"]);
    for (const action of ["done", "mute_sender"]) {
      const { r, body } = await call({ id: ids["b1"], action }, reader);
      expect(r.isError).toBe(true);
      expect(body["error"]).toBe("not_found");
    }
    expect(await rowOf(ids["b1"]!)).toEqual({ status: "open", closed_by: null });
    expect((await storage.engine().query(`SELECT 1 FROM loop_suppressions`)).rows).toEqual([]);
  });

  it("mute_sender closes that sender's reply-owed loops in the write source only; dry_run writes nothing", async () => {
    const preview = await call({ id: ids["a1"], action: "mute_sender", dry_run: true }, writer("mail-a"));
    expect(preview.body).toMatchObject({ ok: true, dry_run: true, changed: true, would_close: [ids["a1"], ids["a2"]] });
    expect(await rowOf(ids["a1"]!)).toEqual({ status: "open", closed_by: null });
    expect((await storage.engine().query(`SELECT 1 FROM loop_suppressions`)).rows).toEqual([]);

    const { body } = await call({ id: ids["a1"], action: "mute_sender" }, writer("mail-a"));
    expect(body).toMatchObject({ ok: true, source_id: "mail-a", kind: "sender", changed: true, closed: [ids["a1"], ids["a2"]] });
    expect(await rowOf(ids["a-promise"]!)).toEqual({ status: "open", closed_by: null });
    expect(await rowOf(ids["b1"]!)).toEqual({ status: "open", closed_by: null });

    // No stored thread for these loops: an unmute cannot re-judge them.
    const un = await call({ id: ids["a1"], action: "unmute_sender" }, writer("mail-a"));
    expect(un.body).toMatchObject({ changed: true, reopened: [], answered: [], unverifiable: [ids["a1"], ids["a2"]] });
    expect(await rowOf(ids["a1"]!)).toEqual({ status: "dropped", closed_by: "unmuted" });
  });

  // Value: protects=an orphaned OAuth client cannot write every source's loops; fails_when=the default
  // effectiveWriteSourceIdForIngress call (undefined = unscoped) is used with the fail-closed flag off.
  it("refuses an authenticated caller with no write source, with the global fail-closed flag off", async () => {
    const orphan: AuthInfo = { token: "t", clientId: "c", scopes: ["read", "write"], isPublic: false };
    for (const action of ["done", "mute_sender", "unmute_thread"]) {
      const { r, body } = await call({ id: ids["b1"], action }, orphan);
      expect(r.isError).toBe(true);
      expect(body["error"]).toBe("permission_denied");
    }
    expect(await rowOf(ids["b1"]!)).toEqual({ status: "open", closed_by: null });
    expect((await storage.engine().query(`SELECT 1 FROM loop_suppressions`)).rows).toEqual([]);
    // tools/list never offers it a call it would refuse.
    const names = visibleToolDefs({ isPublic: false, authInfo: orphan }, isPublicMcpToolForbidden).map(t => t.name);
    expect(names).not.toContain("loops_update");
    expect(names).toContain("page_put");
  });

  it("is hidden from and refused to the public bearer and a starter credential", async () => {
    expect(isPublicMcpToolForbidden("loops_update")).toBe(true);
    const listed = (ctx: Parameters<typeof visibleToolDefs>[0]) => visibleToolDefs(ctx, isPublicMcpToolForbidden).map(t => t.name);
    const starter: AuthInfo = { ...writer("mail-a"), toolSurface: "starter" };
    expect(listed({ isPublic: true })).not.toContain("loops_update");
    expect(listed({ isPublic: false, authInfo: starter })).not.toContain("loops_update");
    expect(listed({ isPublic: false, authInfo: writer("mail-a") })).toContain("loops_update");
    const refused = await call({ id: ids["a1"], action: "done" }, starter);
    expect(refused.body["error"]).toBe("permission_denied");
    // Behind the ingress denylist, the handler itself refuses the anonymous public path too.
    const pub = await call({ id: ids["a1"], action: "done" }, undefined, true);
    expect(pub.r.isError).toBe(true);
    expect(await rowOf(ids["a1"]!)).toEqual({ status: "open", closed_by: null });
  });

  it("the operator path is unscoped", async () => {
    const { body } = await call({ id: ids["b1"], action: "dropped" });
    expect(body["loop"]).toMatchObject({ status: "dropped", closed_by: "owner" });
  });
});
