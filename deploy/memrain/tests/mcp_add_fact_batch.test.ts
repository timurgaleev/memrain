/**
 * add_fact `items` (several facts in one call) and `replaces` (retire one
 * named fact in favour of the new one).
 *
 * A batch is checked whole before anything lands; `replaces` retires only a
 * live fact in the caller's own write source, so a tenant can neither retire
 * nor probe a sibling's fact; the public ingress gets neither feature.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { addFact } from "../src/core/facts.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-factbatch-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["tenant-a", "tenant-b", "acme"]) {
    await storage.engine().query(
      "INSERT INTO sources (id, kind, path_prefix) VALUES ($1, 'other', $2) ON CONFLICT (id) DO NOTHING",
      [id, `/${id}/`],
    );
  }
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const tenant = (sourceId: string, extra: Partial<AuthInfo> = {}): AuthInfo => ({
  token: `tok-${sourceId}`,
  clientId: `client-${sourceId}`,
  scopes: ["read", "write"],
  sourceId,
  allowedSources: [sourceId],
  isPublic: false,
  ...extra,
});

function call(args: Record<string, unknown>, opts: Parameters<typeof dispatchTool>[2] = {}): Promise<ToolCallResult> {
  return dispatchTool(storage, { name: "add_fact", arguments: args }, opts);
}

function body(r: ToolCallResult): Record<string, unknown> {
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

async function factCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM entity_facts`);
  return Number(r.rows[0]!.n);
}

async function row(id: number) {
  const r = await storage.engine().query<{
    forgotten_at: string | null;
    forgotten_cause: string | null;
    superseded_by: number | null;
  }>(`SELECT forgotten_at, forgotten_cause, superseded_by FROM entity_facts WHERE id = $1`, [id]);
  return r.rows[0]!;
}

describe("add_fact items", () => {
  it("saves every item, folding in the top-level defaults", async () => {
    const r = await call({
      entity_slug: "people/alice",
      visibility: "world",
      items: [{ fact: "likes tea" }, { fact: "lives in Lisbon", entity_slug: "people/bob", confidence: 0.6 }],
    });
    expect(r.isError ?? false).toBe(false);
    const b = body(r);
    expect(b.saved).toBe(2);
    expect(b.failed).toBe(0);
    expect(b.partial).toBe(false);
    const items = b.items as Array<{ index: number; id: number; inserted: boolean }>;
    expect(items.map((i) => i.index)).toEqual([0, 1]);
    expect(items.every((i) => typeof i.id === "number" && i.inserted)).toBe(true);
    const rows = await storage.engine().query<{ entity_slug: string; visibility: string; confidence: number }>(
      `SELECT entity_slug, visibility, confidence FROM entity_facts ORDER BY id`,
    );
    expect(rows.rows.map((x) => x.entity_slug)).toEqual(["people/alice", "people/bob"]);
    expect(rows.rows.every((x) => x.visibility === "world")).toBe(true);
    expect(Number(rows.rows[1]!.confidence)).toBeCloseTo(0.6);
  });

  it("writes nothing when one item is malformed", async () => {
    const r = await call({
      entity_slug: "people/alice",
      items: [{ fact: "fine" }, { fact: "" }, { fact: "also fine" }],
    });
    expect(r.isError).toBe(true);
    expect(body(r).error).toBe("invalid_params");
    expect(r.content[0]!.text).toContain("items[1]");
    expect(await factCount()).toBe(0);
  });

  it("refuses unknown item fields, a missing entity, fact plus items, and oversize batches", async () => {
    const cases: Record<string, unknown>[] = [
      { entity_slug: "people/a", items: [{ fact: "x", written_by: "someone" }] },
      { items: [{ fact: "no entity anywhere" }] },
      { entity_slug: "people/a", fact: "single", items: [{ fact: "x" }] },
      { entity_slug: "people/a", replaces: 1, items: [{ fact: "x" }] },
      { entity_slug: "people/a", items: [] },
      { entity_slug: "people/a", items: Array.from({ length: 21 }, (_, i) => ({ fact: `f${i}` })) },
      { entity_slug: "people/a", items: ["bare string"] },
      { entity_slug: "people/a", items: [{ fact: "x", visibility: "everyone" }] },
      { entity_slug: "people/a", items: [{ fact: "x", replaces: 0 }] },
    ];
    for (const args of cases) {
      const r = await call(args);
      expect({ args, error: body(r).error }).toEqual({ args, error: "invalid_params" });
    }
    expect(await factCount()).toBe(0);
  });

  it("still requires fact and entity_slug on a single-fact call", async () => {
    expect(body(await call({ entity_slug: "people/a" })).error).toBe("invalid_params");
    expect(body(await call({ fact: "orphan" })).error).toBe("invalid_params");
  });

  it("is refused on the public ingress, as is replaces", async () => {
    const batch = await call({ entity_slug: "people/a", items: [{ fact: "x" }] }, { isPublic: true });
    expect(body(batch).error).toBe("permission_denied");
    const replace = await call({ entity_slug: "people/a", fact: "x", replaces: 1 }, { isPublic: true });
    expect(body(replace).error).toBe("permission_denied");
    expect(await factCount()).toBe(0);
  });

  it("holds every item to a slug-bound client's prefixes", async () => {
    const bound = tenant("acme", { boundSlugPrefixes: ["people/"] });
    const r = await call({ items: [{ fact: "in", entity_slug: "people/a" }, { fact: "out", entity_slug: "companies/x" }] }, { authInfo: bound });
    expect(body(r).error).toBe("permission_denied");
    expect(await factCount()).toBe(0);
  });

  it("replays a batch by request_id without writing twice", async () => {
    const args = { entity_slug: "people/a", request_id: "batch-1", items: [{ fact: "one" }, { fact: "two" }] };
    const first = body(await call(args));
    const again = body(await call(args));
    expect(again.replayed).toBe(true);
    expect(again.items).toEqual(first.items);
    expect(await factCount()).toBe(2);
  });
});

describe("add_fact replaces", () => {
  it("retires the named fact as superseded by the new one", async () => {
    const old = await addFact(storage, { entity_slug: "people/a", fact: "works at Acme" });
    const r = body(await call({ entity_slug: "people/a", fact: "works at Globex", replaces: old.id }));
    expect(r.replaced).toBe(true);
    const retired = await row(old.id!);
    expect(retired.forgotten_at).not.toBeNull();
    expect(retired.forgotten_cause).toBe("supersede");
    expect(Number(retired.superseded_by)).toBe(r.id as number);
    expect((await row(r.id as number)).forgotten_at).toBeNull();
  });

  it("works per item inside a batch", async () => {
    const old = await addFact(storage, { entity_slug: "people/a", fact: "age 30" });
    const r = body(await call({ entity_slug: "people/a", items: [{ fact: "age 31", replaces: old.id }, { fact: "likes jazz" }] }));
    const items = r.items as Array<{ replaced?: boolean }>;
    expect(items[0]!.replaced).toBe(true);
    expect(items[1]!.replaced).toBeUndefined();
    expect((await row(old.id!)).forgotten_cause).toBe("supersede");
  });

  it("reports an unknown or already-retired fact without failing the write", async () => {
    const r = body(await call({ entity_slug: "people/a", fact: "new claim", replaces: 999_999 }));
    expect(r.replaced).toBe(false);
    expect(r.replace_reason).toBe("not_live_or_out_of_scope");
    expect(typeof r.id).toBe("number");
  });

  it("never retires a fact in another tenant's source", async () => {
    const theirs = await addFact(storage, { entity_slug: "people/a", fact: "B's claim", source_id: "tenant-b" });
    const r = body(await call({ entity_slug: "people/a", fact: "A's claim", replaces: theirs.id }, { authInfo: tenant("tenant-a") }));
    expect(r.replaced).toBe(false);
    expect(r.replace_reason).toBe("not_live_or_out_of_scope");
    expect((await row(theirs.id!)).forgotten_at).toBeNull();
  });

  it("does not retire the fact it just refreshed", async () => {
    const first = body(await call({ entity_slug: "people/a", fact: "same claim" }));
    const again = body(await call({ entity_slug: "people/a", fact: "same claim", replaces: first.id }));
    expect(again.id).toBe(first.id);
    expect(again.replaced).toBe(false);
    expect(again.replace_reason).toBe("same_fact");
    expect((await row(first.id as number)).forgotten_at).toBeNull();
  });
});
