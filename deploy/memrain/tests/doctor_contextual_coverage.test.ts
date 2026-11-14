/**
 * contextual-coverage doctor check: under contextual retrieval, what share of
 * the stored prose vectors were embedded with their document context. Code
 * documents and fenced-code symbols are embedded raw by design, so they stay
 * out of the denominator.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeDocumentTransaction, type ChunkWrite } from "../src/core/indexer-tx.ts";
import { checkContextualCoverage } from "../src/core/doctor-embed.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { storageEngines } from "./helpers/storage-engines.ts";

const ON = { MEMRAIN_CONTEXTUAL_RETRIEVAL: "1" } as NodeJS.ProcessEnv;

function chunk(text: string, extra: Partial<ChunkWrite> = {}): ChunkWrite {
  return { text, entities: [], embedding: deterministicEmbed(text), ...extra };
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`checkContextualCoverage (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => { db = await open(); });
    afterEach(async () => { await db.close(); });

    async function prose(id: string, chunks: ChunkWrite[]) {
      await writeDocumentTransaction(db.storage,
        { documentId: id, sourcePath: `notes/${id}.md`, title: id, frontmatter: {}, embeddingModel: "det" }, chunks);
    }

    it("is not measured while contextual retrieval is off", async () => {
      await prose("a", [chunk("plain one", { contextualTier: "none" })]);
      const r = await checkContextualCoverage(db.storage.engine(), {} as NodeJS.ProcessEnv);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("off");
    });

    it("warns when fewer than half of the prose vectors carry context", async () => {
      await prose("a", [
        chunk("wrapped one", { contextualTier: "deterministic" }),
        chunk("plain two", { contextualTier: "none" }),
        chunk("legacy three"),
        chunk("plain four", { contextualTier: "none" }),
      ]);
      const r = await checkContextualCoverage(db.storage.engine(), ON);
      expect(r.status).toBe("warn");
      expect(r.detail).toContain("1 of 4");
      expect(r.detail).toContain("25%");
    });

    it("passes at or above half and leaves code and unembedded chunks out", async () => {
      await prose("a", [
        chunk("wrapped one", { contextualTier: "deterministic" }),
        chunk("situated two", { contextualTier: "llm" }),
        chunk("plain three", { contextualTier: "none" }),
        chunk("pending four", { contextualTier: "deterministic", embedding: null }),
        chunk("function f() {}", { contextualTier: "none", chunkSource: "fenced_code" }),
        chunk("const g = 1", { contextualTier: "none", chunkSource: "fenced_code" }),
      ]);
      await writeDocumentTransaction(db.storage,
        { documentId: "code", sourcePath: "/repo/x.ts", title: "x.ts", frontmatter: { kind: "code" }, embeddingModel: "det" },
        [chunk("export const x = 1"), chunk("export const y = 2")]);
      const r = await checkContextualCoverage(db.storage.engine(), ON);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("2 of 3");
    });

    it("has nothing to warn about on an empty corpus", async () => {
      const r = await checkContextualCoverage(db.storage.engine(), ON);
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("0 of 0");
    });
  });
}
