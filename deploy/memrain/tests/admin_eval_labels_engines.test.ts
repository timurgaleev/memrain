/**
 * The labelling route's write on both engines: a label saved through the real
 * admin gates must store its relevant documents as a JSON array that the live
 * set and the qrels export read back. Postgres binds a jsonb parameter
 * differently from PGLite, so the PGLite-only route test cannot catch a
 * double-encoded value.
 */
import { describe, expect, it } from "bun:test";
import { createAdminAuth } from "../src/http/admin.ts";
import { handleAdminApi } from "../src/http/admin-api.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { loadLiveQrels } from "../src/eval/live-set.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deterministicEmbed, deterministicEmbedQuery } from "./det-embed.ts";

const ORIGIN = "http://localhost:8080";
const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin eval label (${name})`, () => {
  it("stores every relevant document as an array the live set reads back", async () => {
    const { storage, close } = await open();
    try {
      const auth = createAdminAuth({ bootstrapToken: "boot-secret" });
      const login = await auth.handleAuthRoute(
        req("/admin/login", { method: "POST", body: JSON.stringify({ token: "boot-secret" }) }),
        new URL(`${ORIGIN}/admin/login`),
      );
      const cookie = (login!.headers.get("Set-Cookie") ?? "").split(";")[0]!;
      for (const [path, text] of [
        ["/notes/ledger.md", "# Ledger\n\nThe ledger reconciliation service is owned by the billing team."],
        ["/notes/billing.md", "# Billing\n\nThe billing team owns the ledger and the invoices."],
      ] as const) {
        await indexDocument(storage, { sourcePath: path, text }, { embedFn: async (t) => deterministicEmbed(t), inferFrontmatter: false });
      }
      const e = storage.engine();
      const docs = (await e.query<{ id: string }>(`SELECT id FROM documents ORDER BY source_path`)).rows.map((r) => r.id);
      const res = await handleAdminApi(
        req("/admin/api/eval/label", {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", cookie },
          body: JSON.stringify({ query: "who owns the ledger", expected_doc_ids: docs, tags: ["intent:topic"], lang: "en", split: "dev" }),
        }),
        new URL(`${ORIGIN}/admin/api/eval/label`),
        { storage, requireAdmin: auth.requireAdmin, embedQuery: deterministicEmbedQuery },
      );
      expect(res!.status).toBe(200);
      const row = (await e.query<{ expected_doc_ids: unknown }>(`SELECT expected_doc_ids FROM eval_queries WHERE query = 'who owns the ledger'`)).rows[0]!;
      expect(row.expected_doc_ids).toEqual(docs);
      const live = await loadLiveQrels(e);
      expect(live.queries.map((q) => q.expected_paths)).toEqual([["/notes/billing.md", "/notes/ledger.md"]]);
    } finally {
      await close();
    }
  });
});
