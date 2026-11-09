import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { buildRechunkPlan, rechunkSnapshot, type RechunkOptions } from "../src/core/rechunk-plan.ts";
import { applyRechunkPlan } from "../src/core/rechunk-apply.ts";
import { putPage } from "../src/core/pages.ts";
import { indexPageIntoSearch, reconcilePageMirrors } from "../src/core/page-index.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { rechunkSweepPhase } from "../src/core/cycle/rechunk-sweep.ts";
import { BudgetExhausted } from "../src/core/budget.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`reviewed rechunk (${engine.name})`, () => {
    let storage: Storage;
    let close: () => Promise<void>;
    let root: string;
    let env: Record<string, string | undefined>;
    beforeEach(async () => {
      ({ storage, close } = await engine.open());
      root = mkdtempSync(join(tmpdir(), "memrain-rechunk-plan-"));
      env = Object.fromEntries(["MEMRAIN_VAULT_PATHS", "MEMRAIN_CONTEXTUAL_LLM", "MEMRAIN_CONTEXTUAL_RETRIEVAL", "MEMRAIN_NO_SANITY"].map(k => [k, process.env[k]]));
      process.env.MEMRAIN_VAULT_PATHS = root;
      delete process.env.MEMRAIN_CONTEXTUAL_LLM;
      delete process.env.MEMRAIN_CONTEXTUAL_RETRIEVAL;
    });
    afterEach(async () => {
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await close();
      rmSync(root, { recursive: true, force: true });
    });
    const embed = async (text: string) => deterministicEmbed(text);
    const opts = (): RechunkOptions => ({ source: "vault", vault: root, limit: 10, maxCostUsd: 1 });
    async function seed(name = "a.md") {
      const path = join(root, name);
      const old = "# Old evidence\n\n" + "Original recorded source statement. ".repeat(9);
      await indexDocument(storage, { sourcePath: path, text: old }, { embedFn: embed });
      await storage.engine().query("UPDATE documents SET chunker_version = 2 WHERE source_path = $1", [path]);
      writeFileSync(path, "# Current evidence\n\n" + "Updated source statement with complete lines. ".repeat(9));
      return path;
    }

    it("pins selected inputs/options and previews without changing any stored rows", async () => {
      await seed(); await seed("b.md");
      const before = await storage.engine().query("SELECT to_jsonb(d) AS row FROM documents d ORDER BY id");
      const plan = await buildRechunkPlan(storage, { ...opts(), limit: 1 });
      expect(plan.selected).toBe(1);
      expect(plan.truncated).toBe(true);
      expect(plan.cost_upper_bound_usd).toBeGreaterThan(0);
      expect(plan.plan_hash).not.toBe((await buildRechunkPlan(storage, opts())).plan_hash);
      expect(await storage.engine().query("SELECT to_jsonb(d) AS row FROM documents d ORDER BY id")).toEqual(before);
      expect(plan.plan_hash).toBe((await buildRechunkPlan(storage, { ...opts(), limit: 1 })).plan_hash);
      process.env.MEMRAIN_NO_SANITY = process.env.MEMRAIN_NO_SANITY === "1" ? "0" : "1";
      expect(plan.plan_hash).not.toBe((await buildRechunkPlan(storage, { ...opts(), limit: 1 })).plan_hash);
    });

    it("rejects an altered file before invoking the paid boundary", async () => {
      const path = await seed();
      const plan = await buildRechunkPlan(storage, opts());
      writeFileSync(path, "Changed after review");
      let calls = 0;
      await expect(applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: async t => { calls++; return embed(t); } })).rejects.toThrow("plan changed");
      expect(calls).toBe(0);
    });

    it("refuses zero budget, unknown pricing and paid contextual mode before any embedding", async () => {
      await seed();
      for (const options of [{ ...opts(), maxCostUsd: 0 }, { ...opts(), embeddingModel: "unknown-price" },
        { ...opts(), embeddingModel: "anthropic.claude-haiku-4-5-20251001-v1:0" }]) {
        const plan = await buildRechunkPlan(storage, options);
        expect(plan.applicable).toBe(false);
        await expect(applyRechunkPlan(storage, options, plan.plan_hash, { embedFn: async () => { throw new Error("paid call escaped"); } })).rejects.toThrow("unsupported/unpriced");
      }
      process.env.MEMRAIN_CONTEXTUAL_LLM = "1";
      const plan = await buildRechunkPlan(storage, opts());
      expect(plan.applicable).toBe(false);
      expect(plan.held[0]?.reason).toBe("contextual_llm_requires_separate_budgeted_command");
    });

    it("reserves one paid attempt and disables hidden SDK retries", async () => {
      await seed();
      const plan = await buildRechunkPlan(storage, opts());
      let attempts: number | undefined;
      const out = await applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: async (text, options) => {
        attempts = await options?.client?.config.maxAttempts();
        return embed(text);
      } });
      expect(out.ok).toBe(true);
      expect(attempts).toBe(1);
    });

    it("applies one markdown target within its ceiling and preserves authored pages/facts", async () => {
      await seed();
      const plan = await buildRechunkPlan(storage, opts());
      const out = await applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: embed });
      expect(out.ok).toBe(true);
      expect(out.completed).toEqual(plan.targets.map(t => t.document_id));
      expect(out.embedding_calls).toBeGreaterThan(0);
      expect(out.reserved_cost_upper_bound_usd).toBeLessThanOrEqual(plan.cost_upper_bound_usd);
      expect((await storage.engine().query<{ chunker_version: number }>("SELECT chunker_version FROM documents")).rows[0]?.chunker_version).toBe(3);
      expect((await storage.engine().query("SELECT slug FROM pages")).rows).toEqual([]);
      expect((await storage.engine().query("SELECT id FROM entity_facts")).rows).toEqual([]);
    });

    it("retains the prior chunks when the file changes during embedding", async () => {
      const path = await seed();
      const plan = await buildRechunkPlan(storage, opts());
      const before = await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id);
      const out = await applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: async text => {
        writeFileSync(path, "Concurrent source edit"); return embed(text);
      } });
      expect(out.status).toBe("partial");
      expect(out.completed).toEqual([]);
      expect(out.skipped[0]?.reason).toBe("conflict");
      expect(await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id)).toBe(before);
    });

    it("does not replace old vectors with deferred gaps after a budget refusal", async () => {
      await seed();
      const plan = await buildRechunkPlan(storage, opts());
      const before = await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id);
      const out = await applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: async () => {
        throw new BudgetExhausted("cost", "fixture refusal");
      } });
      expect(out.completed).toEqual([]);
      expect(out.embedding_calls).toBe(1);
      expect(await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id)).toBe(before);
    });

    it("reports exact completed and remaining targets after a later source races", async () => {
      await seed(); await seed("b.md");
      const plan = await buildRechunkPlan(storage, opts());
      let changed = false;
      const out = await applyRechunkPlan(storage, opts(), plan.plan_hash, { embedFn: async text => {
        if (!changed) { changed = true; writeFileSync(plan.targets[1]!.source_path, "Concurrent second edit"); }
        return embed(text);
      } });
      expect(out.completed).toEqual([plan.targets[0]!.document_id]);
      expect(out.remaining).toEqual([plan.targets[1]!.document_id]);
      expect(out.status).toBe("partial");
    });

    it("code graph-only apply costs zero and never invokes the embedding boundary", async () => {
      const path = join(root, "module.ts");
      const text = "export function answer() { return 42; }\n";
      writeFileSync(path, text);
      await indexCodeDocument(storage, { sourcePath: path, text });
      await storage.engine().exec("UPDATE documents SET chunker_version = 0");
      const options: RechunkOptions = { source: "code", codePaths: [root], maxCostUsd: 0, limit: 1 };
      const plan = await buildRechunkPlan(storage, options);
      expect(plan.selected).toBe(1);
      expect(plan.cost_upper_bound_usd).toBe(0);
      let calls = 0;
      const result = await applyRechunkPlan(storage, options, plan.plan_hash, { embedFn: async () => { calls++; throw new Error("unexpected embed"); } });
      expect(result.ok).toBe(true);
      expect(calls).toBe(0);
      expect((await storage.engine().query("SELECT chunk_id FROM embeddings")).rows).toEqual([]);
    });

    it("includes body and truth mirrors only in source all and leaves v2 automatic maintenance idle", async () => {
      await putPage(storage, { slug: "notes/rechunk", title: "Page", markdown_body: "Canonical page body.", compiled_truth: { summary: "Canonical truth" } });
      await indexPageIntoSearch(storage, { slug: "notes/rechunk", title: "Page", markdown_body: "Canonical page body.",
        content_hash: (await storage.engine().query<{ content_hash: string }>("SELECT content_hash FROM pages")).rows[0]!.content_hash,
        compiled_truth: { summary: "Canonical truth" }, source_id: "default" }, { embedFn: embed });
      const file = await seed();
      await storage.engine().exec("UPDATE documents SET chunker_version = 2");
      let calls = 0;
      const counting = async (text: string) => { calls++; return embed(text); };
      await reconcilePageMirrors(storage, { embedFn: counting });
      await rechunkSweepPhase(storage.engine(), { embedFn: counting });
      expect(calls).toBe(0);
      const all = await buildRechunkPlan(storage, { ...opts(), source: "all" });
      expect(all.targets.map(t => t.kind).sort()).toEqual(["markdown", "page", "truth"]);
      const vault = await buildRechunkPlan(storage, opts());
      expect(vault.targets.map(t => t.source_path)).toEqual([file]);
      const before = await storage.engine().query("SELECT to_jsonb(p) AS row FROM pages p");
      const result = await applyRechunkPlan(storage, { ...opts(), source: "all" }, all.plan_hash, { embedFn: counting });
      expect(result.ok).toBe(true);
      expect(await storage.engine().query("SELECT to_jsonb(p) AS row FROM pages p")).toEqual(before);
    });

    it("keeps the previous code graph when the reviewed input cannot parse completely", async () => {
      const path = join(root, "broken.ts");
      await indexCodeDocument(storage, { sourcePath: path, text: "export function valid() { return 1; }" });
      await storage.engine().exec("UPDATE documents SET chunker_version = 0");
      writeFileSync(path, "export function broken( { return ???;");
      const options: RechunkOptions = { source: "code", codePaths: [root], maxCostUsd: 0 };
      const plan = await buildRechunkPlan(storage, options);
      const before = await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id);
      const result = await applyRechunkPlan(storage, options, plan.plan_hash);
      expect(result.completed).toEqual([]);
      expect(await rechunkSnapshot(storage.engine(), plan.targets[0]!.document_id)).toBe(before);
    });
  });
}
