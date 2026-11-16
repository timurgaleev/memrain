/**
 * /admin/api/eval/*: the labelling screen for the live eval set, through the
 * real admin gates (session cookie, same-origin check on writes) with the
 * headers a browser sends from the admin page.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { loadLiveQrels } from "../src/eval/live-set.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const BOOT = "boot-secret";
const ORIGIN = "http://localhost:8080";
let tmp: string;
let storage: Storage;
let auth: ReturnType<typeof createAdminAuth>;
let cookie: string;

const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);
const call = (path: string, init?: RequestInit) =>
  handleAdminApi(req(path, init), new URL(`${ORIGIN}${path}`), { storage, requireAdmin: auth.requireAdmin, embedQuery: deterministicEmbedQuery });
/** What the admin page's fetch() sends for a same-origin POST. */
const browser = { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { ...browser, cookie, ...headers }, body: JSON.stringify(body) });
const get = async (path: string) => (await call(path, { headers: { cookie } }))!;

let candidateId: number;
let docId: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-admin-eval-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  auth = createAdminAuth({ bootstrapToken: BOOT });
  const login = await auth.handleAuthRoute(
    req("/admin/login", { method: "POST", body: JSON.stringify({ token: BOOT }) }),
    new URL(`${ORIGIN}/admin/login`),
  );
  cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  for (const [path, text] of [
    ["/notes/ledger.md", "# Ledger\n\nThe ledger reconciliation service is owned by the billing team."],
    ["/notes/garden.md", "# Garden\n\nTomatoes need sun in the south bed."],
  ] as const) {
    await indexDocument(storage, { sourcePath: path, text }, { embedFn: async (t) => deterministicEmbed(t), inferFrontmatter: false });
  }
  const e = storage.engine();
  docId = (await e.query<{ id: string }>(`SELECT id FROM documents WHERE source_path = '/notes/ledger.md'`)).rows[0]!.id;
  candidateId = (await e.query<{ id: number }>(
    `INSERT INTO eval_candidates (tool_name, query, scrubbed, result_count) VALUES ('mcp.search', 'who owns the ledger service', true, 2) RETURNING id`,
  )).rows[0]!.id;
  await e.query(`INSERT INTO eval_candidates (tool_name, query, scrubbed) VALUES ('mcp.search', 'tomato sun', true)`);
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("admin eval labelling", () => {
  it("401s without a session and refuses a cross-origin or opaque-origin write", async () => {
    expect((await call("/admin/api/eval/candidates"))?.status).toBe(401);
    expect((await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: [docId] }, { origin: "https://evil.example" }))?.status).toBe(403);
    expect((await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: [docId] }, { origin: "null" }))?.status).toBe(403);
  });

  it("lists unlabelled candidates with the label counts", async () => {
    const res = await get("/admin/api/eval/candidates");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { candidates: { id: number; query: string; scrubbed: boolean }[]; labels: { dev: number; sealed: number; target: number } };
    expect(body.candidates.map((c) => c.query)).toContain("who owns the ledger service");
    expect(body.labels).toMatchObject({ dev: 0, sealed: 0, target: 150 });
  });

  it("previews the top documents for a candidate with paid stages off", async () => {
    const res = (await post("/admin/api/eval/preview", { candidate_id: candidateId }))!;
    expect(res.status).toBe(200);
    const body = await res.json() as { query: string; results: { document_id: string; source_path: string; title: string | null }[] };
    expect(body.query).toBe("who owns the ledger service");
    expect(body.results[0]!.source_path).toBe("/notes/ledger.md");
    expect(body.results.length).toBeLessThanOrEqual(10);
  });

  it("labels a candidate with its relevant documents, tags and split, once", async () => {
    const bad = (await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: ["doc_missing"], tags: ["kind:entity"] }))!;
    expect(bad.status).toBe(400);
    const badTag = (await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: [docId], tags: ["Has Space"] }))!;
    expect(badTag.status).toBe(400);
    const ok = (await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: [docId], tags: ["kind:entity"], lang: "en", split: "dev" }))!;
    expect(ok.status).toBe(200);
    const again = (await post("/admin/api/eval/label", { candidate_id: candidateId, expected_doc_ids: [docId] }))!;
    expect(again.status).toBe(409);
    // The label is a live dev qrel under the document's current path.
    const qrels = await loadLiveQrels(storage.engine());
    expect(qrels.queries).toHaveLength(1);
    expect(qrels.queries[0]).toMatchObject({ query: "who owns the ledger service", expected_paths: ["/notes/ledger.md"], tags: ["kind:entity"], lang: "en" });
    // A labelled candidate leaves the queue.
    const list = await (await get("/admin/api/eval/candidates")).json() as { candidates: { id: number }[]; labels: { dev: number } };
    expect(list.candidates.map((c) => c.id)).not.toContain(candidateId);
    expect(list.labels.dev).toBe(1);
  });

  it("assigns a split by query hash when the operator leaves it to the server", async () => {
    const res = (await post("/admin/api/eval/label", { query: "tomatoes south bed", expected_doc_ids: [docId] }))!;
    expect(res.status).toBe(200);
    const { split } = await res.json() as { split: string };
    expect(["dev", "sealed"]).toContain(split);
  });

  it("dismisses a candidate and deletes a label", async () => {
    const e = storage.engine();
    const other = (await e.query<{ id: number }>(`SELECT id FROM eval_candidates WHERE query = 'tomato sun'`)).rows[0]!.id;
    expect((await post("/admin/api/eval/dismiss", { candidate_id: other }))!.status).toBe(200);
    expect((await e.query(`SELECT 1 FROM eval_candidates WHERE id = $1`, [other])).rows).toHaveLength(0);
    const labels = await (await get("/admin/api/eval/labels")).json() as { labels: { id: string }[] };
    expect(labels.labels.length).toBe(2);
    expect((await post("/admin/api/eval/labels/delete", { id: labels.labels[0]!.id }))!.status).toBe(200);
    expect((await (await get("/admin/api/eval/labels")).json() as { labels: unknown[] }).labels.length).toBe(1);
  });
});
