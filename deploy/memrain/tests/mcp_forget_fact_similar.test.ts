/**
 * forget_fact `similar_active`: after a forget, the live facts about the same
 * entity that read close to the withdrawn claim — ids and scores only, never
 * text, and never past the source and visibility the forget itself reached.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { addFact } from "../src/core/facts.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-forgetsim-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["tenant-a", "tenant-b"]) {
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

const tenantA: AuthInfo = {
  token: "tok-a",
  clientId: "client-a",
  scopes: ["read", "write"],
  sourceId: "tenant-a",
  allowedSources: ["tenant-a"],
  isPublic: false,
};

interface Similar {
  state: string;
  method: string | null;
  candidates: Array<{ fact_id: number; similarity: number }>;
  next: string;
}

async function forget(id: number, opts: Parameters<typeof dispatchTool>[2] = {}) {
  const r = await dispatchTool(storage, { name: "forget_fact", arguments: { id } }, opts);
  expect(r.isError ?? false).toBe(false);
  return { text: r.content[0]!.text, body: JSON.parse(r.content[0]!.text) as { forgotten: boolean; similar_active?: Similar } };
}

async function seed(fact: string, extra: Partial<Parameters<typeof addFact>[1]> = {}): Promise<number> {
  const r = await addFact(storage, { entity_slug: "people/alice", fact, ...extra });
  return r.id!;
}

function vec(head: number[]): string {
  const v = Array.from<number>({ length: 1024 }).fill(0);
  head.forEach((x, i) => (v[i] = x));
  return `[${v.join(",")}]`;
}

async function setEmbedding(id: number, head: number[]): Promise<void> {
  await storage.engine().query(`UPDATE entity_facts SET embedding = $2::vector WHERE id = $1`, [id, vec(head)]);
}

describe("forget_fact similar_active", () => {
  it("lists close rewordings by text similarity when the fact has no embedding", async () => {
    const gone = await seed("Alice works at Acme Corporation in Berlin");
    const close = await seed("Alice works at the Acme Corporation in Berlin");
    await seed("Alice enjoys long-distance cycling");
    await seed("Alice works at Acme Corporation in Berlin", { entity_slug: "people/bob" });
    const { text, body } = await forget(gone);
    expect(body.forgotten).toBe(true);
    const s = body.similar_active!;
    expect(s.state).toBe("checked");
    expect(s.method).toBe("trigram");
    expect(s.candidates.map((c) => c.fact_id)).toEqual([close]);
    expect(s.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.45);
    // Ids and scores only: no fact text in the response.
    expect(text).not.toContain("Acme");
    expect(text).not.toContain("cycling");
  });

  it("ranks by embedding cosine when the withdrawn fact has one", async () => {
    const gone = await seed("employer: Acme");
    const near = await seed("current job is at the Acme company");
    const far = await seed("employer: Acme!"); // textually close, semantically placed far
    await setEmbedding(gone, [1, 0]);
    await setEmbedding(near, [0.95, 0.31]);
    await setEmbedding(far, [0, 1]);
    const { body } = await forget(gone);
    const s = body.similar_active!;
    expect(s.method).toBe("embedding");
    expect(s.candidates.map((c) => c.fact_id)).toEqual([near]);
    expect(s.candidates[0]!.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("caps the list at five", async () => {
    const gone = await seed("Alice lives in Lisbon Portugal");
    for (let i = 0; i < 7; i++) await seed(`Alice lives in Lisbon Portugal ${i}`);
    const { body } = await forget(gone);
    expect(body.similar_active!.candidates.length).toBe(5);
  });

  it("stays inside the caller's source and shows a remote caller only world facts", async () => {
    const gone = await seed("Alice works at Acme Corporation in Berlin", { source_id: "tenant-a", visibility: "world" });
    const own = await seed("Alice works at the Acme Corporation in Berlin", { source_id: "tenant-a", visibility: "world" });
    await seed("Alice works at the Acme Corporation in Berlin.", { source_id: "tenant-b", visibility: "world" });
    await seed("Alice works at the Acme Corporation, Berlin", { source_id: "tenant-a", visibility: "private" });
    const { body } = await forget(gone, { authInfo: tenantA });
    expect(body.similar_active!.candidates.map((c) => c.fact_id)).toEqual([own]);
  });

  it("never names private facts to a tenant, though the operator sees them", async () => {
    const tenantGone = await seed("Alice works at Acme Corporation in Berlin", { source_id: "tenant-a" });
    await seed("Alice works at the Acme Corporation in Berlin", { source_id: "tenant-a" });
    expect((await forget(tenantGone, { authInfo: tenantA })).body.similar_active!.candidates).toEqual([]);
    const opGone = await seed("Alice lives in Lisbon, Portugal", { source_id: "tenant-a" });
    const opClose = await seed("Alice lives in Lisbon Portugal", { source_id: "tenant-a" });
    const op = (await forget(opGone)).body.similar_active!;
    expect(op.candidates.map((c) => c.fact_id)).toEqual([opClose]);
  });

  it("is absent when the forget flipped nothing", async () => {
    const id = await seed("Alice likes tea");
    await forget(id);
    const { body } = await forget(id);
    expect(body.forgotten).toBe(false);
    expect(body.similar_active).toBeUndefined();
  });
});
