/**
 * Conditional and idempotent writes: `expected_version` / `force` on
 * page_put, page_revert and page_delete (checked under the slug lock), and
 * `request_id` replay on page_put, page_append, add_fact and
 * add_timeline_event (migration 119). Also: get_raw_data hides a soft-deleted
 * page's payloads. Drives the real dispatchTool path over PGLite.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, writeRequestPrincipal, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { registerSource } from "../src/core/sources.ts";
import { deletePage, getPage, putPage, VersionConflictError } from "../src/core/pages.ts";
import { getRawData, putRawData } from "../src/core/raw-data.ts";
import { purgeExpiredWriteRequests } from "../src/core/write-requests.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const A = "wreq-a";
const B = "wreq-b";

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

async function versionOf(slug: string): Promise<number> {
  return payload(await call("page_get", { slug })).version;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-wreq-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/wreq-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/wreq-b" });
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("expected_version", () => {
  it("page_get reports the version a conditional write names", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    await putPage(storage, { slug: "notes/v", markdown_body: "two" });
    expect(await versionOf("notes/v")).toBe(2);
  });

  it("page_get pairs the body with its own version when a put lands right after the read", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    const engine = storage.engine();
    const query = engine.query.bind(engine);
    let injected = false;
    // Commit a second version the moment the page row has been read: a version
    // read by a separate query after this point would say 2 beside body "one".
    engine.query = (async (sql: string, params?: unknown[]) => {
      const r = await query(sql, params);
      if (!injected && /FROM pages\s+WHERE slug = \$1/.test(sql)) {
        injected = true;
        await putPage(storage, { slug: "notes/v", markdown_body: "two" });
      }
      return r;
    }) as typeof engine.query;
    let got: any;
    try {
      got = payload(await call("page_get", { slug: "notes/v" }));
    } finally {
      engine.query = query;
    }
    expect(injected).toBe(true);
    expect(got.page.markdown_body).toBe("one");
    expect(got.version).toBe(1);
    expect(got.page.version).toBeUndefined();
    const stale = payload(await call("page_put", { slug: "notes/v", markdown_body: "mine", expected_version: got.version }));
    expect(stale.error).toBe("version_conflict");
    expect((await getPage(storage, "notes/v"))!.markdown_body).toBe("two");
  });

  it("writes on a match and refuses a stale version without writing", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    const ok = payload(await call("page_put", { slug: "notes/v", markdown_body: "two", expected_version: 1 }));
    expect(ok.version_n).toBe(2);

    const stale = await call("page_put", { slug: "notes/v", markdown_body: "three", expected_version: 1 });
    expect(stale.isError).toBe(true);
    const env = payload(stale);
    expect(env.error).toBe("version_conflict");
    expect(env.current_version).toBe(2);
    expect(env.expected_version).toBe(1);
    expect((await getPage(storage, "notes/v"))!.markdown_body).toBe("two");
    expect(await versionOf("notes/v")).toBe(2);
  });

  it("names the current version on public ingress too, without the message", () => {
    const env = new VersionConflictError("notes/v", 2, 1).toEnvelope(true);
    expect(env).toEqual({
      error: "version_conflict",
      error_class: "conflict",
      retryable: false,
      suggestion: expect.any(String),
      current_version: 2,
      expected_version: 1,
    });
  });

  it("0 means create-only", async () => {
    const created = payload(await call("page_put", { slug: "notes/new", markdown_body: "hi", expected_version: 0 }));
    expect(created.created).toBe(true);
    const again = payload(await call("page_put", { slug: "notes/new", markdown_body: "again", expected_version: 0 }));
    expect(again.error).toBe("version_conflict");
    expect(again.current_version).toBe(1);
  });

  it("two concurrent puts with the same expected_version: exactly one commits", async () => {
    await putPage(storage, { slug: "notes/race", markdown_body: "base" });
    const [a, b] = await Promise.allSettled([
      putPage(storage, { slug: "notes/race", markdown_body: "from a", expectedVersion: 1 }),
      putPage(storage, { slug: "notes/race", markdown_body: "from b", expectedVersion: 1 }),
    ]);
    const won = [a, b].filter((r) => r.status === "fulfilled");
    const lost = [a, b].filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);
    expect(await versionOf("notes/race")).toBe(2);
    const body = (await getPage(storage, "notes/race"))!.markdown_body;
    expect(["from a", "from b"]).toContain(body);
  });

  it("omitted keeps today's unconditional write; force is the explicit form", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    expect(payload(await call("page_put", { slug: "notes/v", markdown_body: "two" })).version_n).toBe(2);
    expect(payload(await call("page_put", { slug: "notes/v", markdown_body: "three", force: true })).version_n).toBe(3);
  });

  it("refuses expected_version together with force: true", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    const r = payload(await call("page_put", { slug: "notes/v", markdown_body: "two", expected_version: 1, force: true }));
    expect(r.error).toBe("invalid_params");
    expect(await versionOf("notes/v")).toBe(1);
  });

  it("page_revert checks the version before rolling back", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    await putPage(storage, { slug: "notes/v", markdown_body: "two" });
    const stale = payload(await call("page_revert", { slug: "notes/v", version: 1, expected_version: 1 }));
    expect(stale.error).toBe("version_conflict");
    expect((await getPage(storage, "notes/v"))!.markdown_body).toBe("two");
    const ok = payload(await call("page_revert", { slug: "notes/v", version: 1, expected_version: 2 }));
    expect(ok.reverted).toBe(true);
    expect((await getPage(storage, "notes/v"))!.markdown_body).toBe("one");
  });

  it("page_delete checks the version before deleting", async () => {
    await putPage(storage, { slug: "notes/v", markdown_body: "one" });
    await putPage(storage, { slug: "notes/v", markdown_body: "two" });
    const stale = payload(await call("page_delete", { slug: "notes/v", expected_version: 1 }));
    expect(stale.error).toBe("version_conflict");
    expect(await getPage(storage, "notes/v")).not.toBeNull();
    const ok = payload(await call("page_delete", { slug: "notes/v", expected_version: 2 }));
    expect(ok.already_deleted).toBe(false);
    expect(await getPage(storage, "notes/v")).toBeNull();
  });

  it("another tenant's page reads as version 0 to a scoped delete", async () => {
    await putPage(storage, { slug: "notes/owned-by-a", markdown_body: "a", source_id: A });
    await putPage(storage, { slug: "notes/owned-by-a", markdown_body: "a2", source_id: A });
    const r = payload(await call("page_delete", { slug: "notes/owned-by-a", expected_version: 2 }, auth(B)));
    expect(r.error).toBe("version_conflict");
    expect(r.current_version).toBe(0);
  });
});

describe("request_id", () => {
  it("a replayed page_append does not append twice", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    const args = { slug: "notes/log", content: "line one", request_id: "req-1" };
    const first = payload(await call("page_append", args));
    expect(first.replayed).toBeUndefined();
    const second = payload(await call("page_append", args));
    expect(second.replayed).toBe(true);
    expect(second.version_n).toBe(first.version_n);
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start\nline one");
  });

  it("a replayed page_put writes nothing even after the page moved on", async () => {
    const args = { slug: "notes/p", markdown_body: "first", request_id: "put-1" };
    const first = payload(await call("page_put", args));
    await putPage(storage, { slug: "notes/p", markdown_body: "someone else" });
    const replay = payload(await call("page_put", args));
    expect(replay.replayed).toBe(true);
    expect(replay.version_n).toBe(first.version_n);
    expect((await getPage(storage, "notes/p"))!.markdown_body).toBe("someone else");
  });

  it("a failure after the append committed still blocks a second append on retry", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    const engine = storage.engine();
    const query = engine.query.bind(engine);
    let failed = false;
    // The derived work after the commit (link watermark) throws once.
    engine.query = (async (sql: string, params?: unknown[]) => {
      if (!failed && sql.includes("links_extracted_at = NOW()")) {
        failed = true;
        throw new Error("derived sync failed");
      }
      return query(sql, params);
    }) as typeof engine.query;
    const args = { slug: "notes/log", content: "line one", request_id: "req-post" };
    let first: ToolCallResult;
    try {
      first = await call("page_append", args);
    } finally {
      engine.query = query;
    }
    expect(failed).toBe(true);
    expect(first.isError).toBe(true);
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start\nline one");

    const retry = payload(await call("page_append", args));
    expect(retry.replayed).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.version_n).toBe(2);
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start\nline one");
  });

  it("a claim taken over while its first holder was still running commits only once", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    const { recordWriteRequest } = await import("../src/core/write-requests.ts");
    const key = { principal: "operator", tool: "page_append", requestId: "dup" };
    await storage.engine().query(
      `INSERT INTO write_requests (principal, tool, request_id, args_hash, result)
       VALUES ('operator', 'page_append', 'dup', 'h', '{"ok":true}'::jsonb)`,
    );
    await expect(
      storage.engine().transaction(async (tx) => recordWriteRequest(tx, key, { ok: true })),
    ).rejects.toThrow(/already completed/);
    const { appendPage } = await import("../src/core/pages.ts");
    await expect(appendPage(storage, { slug: "notes/log", content: "again", receipt: key })).rejects.toThrow();
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start");
  });

  it("refuses the same id with different arguments", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    await call("page_append", { slug: "notes/log", content: "one", request_id: "req-x" });
    const r = await call("page_append", { slug: "notes/log", content: "two", request_id: "req-x" });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("invalid_params");
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start\none");
  });

  it("a failed write is not remembered, so its retry runs", async () => {
    const args = { slug: "notes/later", content: "x", request_id: "req-f" };
    expect((await call("page_append", args)).isError).toBe(true);
    await putPage(storage, { slug: "notes/later", markdown_body: "now exists" });
    const r = payload(await call("page_append", args));
    expect(r.replayed).toBeUndefined();
    expect((await getPage(storage, "notes/later"))!.markdown_body).toBe("now exists\nx");
  });

  it("tenant B never sees tenant A's stored result under the same id", async () => {
    await putPage(storage, { slug: "notes/a-log", markdown_body: "a", source_id: A });
    await putPage(storage, { slug: "notes/b-log", markdown_body: "b", source_id: B });
    const aResult = payload(await call("page_append", { slug: "notes/a-log", content: "from a", request_id: "shared" }, auth(A)));
    expect(aResult.ok).toBe(true);

    // Same id, B's own page: runs as B's own write, not a replay of A's.
    const bOwn = payload(await call("page_append", { slug: "notes/b-log", content: "from b", request_id: "shared" }, auth(B)));
    expect(bOwn.replayed).toBeUndefined();
    expect(bOwn.slug).toBe("notes/b-log");

    // Same id AND A's exact arguments: B gets no replay of A's result — the
    // call runs under B's grant and cannot reach A's page.
    const bProbe = await call("page_append", { slug: "notes/a-log", content: "from a", request_id: "shared" }, auth(B));
    expect(bProbe.isError).toBe(true);
    expect(bProbe.content[0]!.text).not.toContain("replayed");
    expect((await getPage(storage, "notes/a-log"))!.markdown_body).toBe("a\nfrom a");
  });

  it("principals separate operator, public, clients, enrollments and sources", () => {
    expect(writeRequestPrincipal({}, undefined)).toBe("operator");
    expect(writeRequestPrincipal({ isPublic: true }, undefined)).toBe("public");
    expect(writeRequestPrincipal({ authInfo: auth(A) }, A)).toBe(`client:client-${A}|source:${A}`);
    expect(writeRequestPrincipal({ authInfo: { ...auth(A), isPublic: true }, isPublic: true }, A)).toBe(`client:client-${A}|source:${A}`);
    expect(writeRequestPrincipal({ authInfo: { ...auth(A), spendId: "enr-1" } }, A)).toBe(`client:client-${A}|enrollment:enr-1|source:${A}`);
  });

  it("replays add_fact and add_timeline_event", async () => {
    await putPage(storage, { slug: "people/alice", markdown_body: "alice" });
    const fact = { entity_slug: "people/alice", fact: "Alice likes tea", request_id: "f-1" };
    const f1 = payload(await call("add_fact", fact));
    const f2 = payload(await call("add_fact", fact));
    expect(f2.replayed).toBe(true);
    expect(f2.id).toBe(f1.id);

    const ev = { slug: "people/alice", occurred_at: "2026-01-02T00:00:00Z", event: "met Bob", request_id: "t-1" };
    await call("add_timeline_event", ev);
    expect(payload(await call("add_timeline_event", ev)).replayed).toBe(true);
    const n = await storage.engine().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timeline_events WHERE slug = 'people/alice' AND event = 'met Bob'",
    );
    expect(n.rows[0]!.n).toBe(1);
  });

  it("a call still in flight is reported, and a dead one is taken over", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    const args = { slug: "notes/log", content: "x", request_id: "busy" };
    const { writeRequestArgsHash } = await import("../src/core/write-requests.ts");
    await storage.engine().query(
      `INSERT INTO write_requests (principal, tool, request_id, args_hash)
       VALUES ('operator', 'page_append', 'busy', $1)`,
      [writeRequestArgsHash(args)],
    );
    const busy = payload(await call("page_append", args));
    expect(busy.error).toBe("request_in_progress");
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start");

    await storage.engine().query("UPDATE write_requests SET created_at = NOW() - INTERVAL '1 hour' WHERE request_id = 'busy'");
    const ran = payload(await call("page_append", args));
    expect(ran.ok).toBe(true);
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("start\nx");
  });

  it("a stale holder that fails later leaves the claim that took it over alone", async () => {
    const { claimWriteRequest, recordWriteRequest, releaseWriteRequest } = await import("../src/core/write-requests.ts");
    const base = { principal: "operator", tool: "page_append", requestId: "slow" };
    const first = await claimWriteRequest(storage.engine(), base, "h");
    if (first.kind !== "claimed") throw new Error("expected a claim");
    await storage.engine().query("UPDATE write_requests SET created_at = NOW() - INTERVAL '1 hour' WHERE request_id = 'slow'");
    const staleKey = { ...base, claimedAt: (await storage.engine().query<{ t: string }>(
      "SELECT created_at::text AS t FROM write_requests WHERE request_id = 'slow'",
    )).rows[0]!.t };
    const second = await claimWriteRequest(storage.engine(), base, "h");
    if (second.kind !== "claimed") throw new Error("expected a takeover");
    const liveKey = { ...base, claimedAt: second.claimedAt };

    // The first call finally fails: its release must not drop the live claim,
    // and it can no longer stamp a receipt either.
    await releaseWriteRequest(storage.engine(), staleKey);
    await expect(
      storage.engine().transaction(async (tx) => recordWriteRequest(tx, staleKey, { ok: true })),
    ).rejects.toThrow(/lost its claim/);
    await storage.engine().transaction(async (tx) => recordWriteRequest(tx, liveKey, { ok: true, n: 2 }));
    const row = await storage.engine().query<{ result: Record<string, unknown> }>(
      "SELECT result FROM write_requests WHERE request_id = 'slow'",
    );
    expect(row.rows[0]!.result).toEqual({ ok: true, n: 2 });
  });

  it("rejects an over-long id", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    const r = payload(await call("page_append", { slug: "notes/log", content: "x", request_id: "r".repeat(129) }));
    expect(r.error).toBe("invalid_params");
  });

  it("the purge prunes records past the replay window", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    await call("page_append", { slug: "notes/log", content: "x", request_id: "old" });
    await call("page_append", { slug: "notes/log", content: "y", request_id: "new" });
    await storage.engine().query("UPDATE write_requests SET created_at = NOW() - INTERVAL '8 days' WHERE request_id = 'old'");
    expect(await purgeExpiredWriteRequests(storage.engine())).toBe(1);
    const left = await storage.engine().query<{ request_id: string }>("SELECT request_id FROM write_requests");
    expect(left.rows.map((r) => r.request_id)).toEqual(["new"]);
  });
});

describe("get_raw_data", () => {
  it("returns nothing for a soft-deleted page", async () => {
    await putPage(storage, { slug: "people/gone", markdown_body: "x" });
    await putRawData(storage, "people/gone", "importer", { v: 1 });
    expect(await getRawData(storage, "people/gone")).toHaveLength(1);
    await deletePage(storage, "people/gone");
    expect(await getRawData(storage, "people/gone")).toHaveLength(0);
    expect(payload(await call("get_raw_data", { slug: "people/gone" })).raw_data).toEqual([]);
  });
});
