/**
 * Readiness signal on empty code lookups: an empty `code_def` has to say
 * whether the symbol is missing, the graph was never built, the files hold no
 * symbols, or the boot sweep is still running — counted over the caller's
 * sources only. Offline (PGLite, no Bedrock).
 */
import { afterAll, beforeAll, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexCodeDocument } from "../src/core/indexer-code.ts";
import { _resetParsersForTests } from "../src/core/chunkers/parsers.ts";
import { codeCallees, codeCallers, codeDefs, codeIndexReadiness, codeRefs } from "../src/core/code-graph.ts";
import { codeSweepInProgress, sweepCodeRoots } from "../src/core/sweep-code.ts";
import { runRecursiveWalk } from "../src/core/code-walk.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

setDefaultTimeout(60000);

let tmp: string;
let storage: Storage;
let engine: Engine;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-code-readiness-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  engine = storage.engine();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  _resetParsersForTests();
});

/** A sweep whose first query blocks until released, so the flag can be observed mid-run. */
function blockingStorage(): { storage: Storage; release: (fail: boolean) => void } {
  let release!: (fail: boolean) => void;
  const gate = new Promise<boolean>((res) => {
    release = res;
  });
  const fake = {
    raw: () => ({
      query: async () => {
        if (await gate) throw new Error("boom");
        return { rows: [] };
      },
    }),
  } as unknown as Storage;
  return { storage: fake, release };
}

describe("codeSweepInProgress", () => {
  it("is true while a sweep runs and false after it finishes", async () => {
    const { storage: fake, release } = blockingStorage();
    expect(codeSweepInProgress()).toBe(false);
    const run = sweepCodeRoots(fake, { paths: [] });
    expect(codeSweepInProgress()).toBe(true);
    release(false);
    await run;
    expect(codeSweepInProgress()).toBe(false);
  });

  it("clears after a sweep that throws", async () => {
    const { storage: fake, release } = blockingStorage();
    const run = sweepCodeRoots(fake, { paths: [] });
    expect(codeSweepInProgress()).toBe(true);
    release(true);
    await expect(run).rejects.toThrow("boom");
    expect(codeSweepInProgress()).toBe(false);
  });
});

describe("codeIndexReadiness", () => {
  it("reports not_built on an empty brain, on every empty lookup", async () => {
    expect(await codeIndexReadiness(engine)).toEqual({ state: "not_built", code_documents: 0, symbols: 0 });
    const def = await codeDefs(engine, "anything");
    expect(def.readiness?.state).toBe("not_built");
    expect((await codeRefs(engine, "anything")).readiness?.state).toBe("not_built");
    expect((await codeCallers(engine, "anything")).readiness?.state).toBe("not_built");
    const callees = await codeCallees(engine, "/nowhere.ts:3");
    expect(callees.resolved_symbol).toBeNull();
    expect(callees.readiness?.state).toBe("not_built");
  });

  it("reports indexing while a sweep runs, whatever the counts say", async () => {
    const { storage: fake, release } = blockingStorage();
    const run = sweepCodeRoots(fake, { paths: [] });
    try {
      expect((await codeDefs(engine, "anything")).readiness?.state).toBe("indexing");
    } finally {
      release(false);
      await run;
    }
    expect((await codeIndexReadiness(engine)).state).toBe("not_built");
  });

  it("gives a caller granted nothing not_built without touching the database", async () => {
    const query = mock(async () => ({ rows: [] }));
    const spy = { query } as unknown as Engine;
    expect(await codeIndexReadiness(spy, [])).toEqual({ state: "not_built", code_documents: 0, symbols: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  describe("with indexed code", () => {
    beforeAll(async () => {
      await registerSource(engine, { id: "tenant-a", kind: "vault", pathPrefix: "/tenant-a" });
      await registerSource(engine, { id: "tenant-b", kind: "vault", pathPrefix: "/tenant-b" });
      await registerSource(engine, { id: "tenant-c", kind: "vault", pathPrefix: "/tenant-c" });
      await registerSource(engine, { id: "tenant-d", kind: "vault", pathPrefix: "/tenant-d" });
      await registerSource(engine, { id: "tenant-e", kind: "vault", pathPrefix: "/tenant-e" });
      await indexCodeDocument(storage, {
        sourcePath: "/tenant-a/svc.ts",
        text: "export function alpha() { return 1; }\nexport function beta() { return alpha(); }\n",
        sourceId: "tenant-a",
      });
      await indexCodeDocument(storage, {
        sourcePath: "/tenant-c/script.py",
        text: "import os\nprint(os.getcwd())\nx = 1\n",
        sourceId: "tenant-c",
      });
      // Edges intact, mentions gone — the state a mention wipe leaves behind.
      await indexCodeDocument(storage, {
        sourcePath: "/tenant-d/walk.ts",
        text: "export function gamma() { return 1; }\nexport function delta() { return gamma(); }\n",
        sourceId: "tenant-d",
      });
      await engine.query(
        `DELETE FROM entity_mentions em USING chunks c, documents d
          WHERE em.chunk_id = c.id AND c.document_id = d.id AND d.source_id = 'tenant-d'`,
      );
      await indexCodeDocument(storage, {
        sourcePath: "/tenant-e/gone.ts",
        text: "export function epsilon() { return 1; }\n",
        sourceId: "tenant-e",
      });
      await engine.query("UPDATE documents SET deleted_at = now() WHERE source_id = 'tenant-e'");
    });

    it("counts the edge graph for the walk tools, the mention graph for the lookups", async () => {
      const walk = await runRecursiveWalk(engine, "zzNoSuchSymbol", {
        direction: "callers",
        exact: true,
        sourceIds: ["tenant-d"],
      });
      expect(walk.result).toBe("ok");
      const readiness = walk.result === "ok" ? walk.readiness : undefined;
      expect(readiness?.state).toBe("ready");
      expect(readiness?.symbols).toBeGreaterThan(0);
      expect((await codeDefs(engine, "zzNoSuchSymbol", undefined, ["tenant-d"])).readiness?.state)
        .toBe("no_symbols");
    });

    it("counts module definitions as well as references in top-level scripts", async () => {
      // tenant-c holds an import and its enclosing module definition.
      expect((await codeRefs(engine, "zzNoSuchSymbol", undefined, ["tenant-c"])).readiness?.state)
        .toBe("ready");
      expect((await codeDefs(engine, "zzNoSuchSymbol", undefined, ["tenant-c"])).readiness?.state)
        .toBe("ready");
      expect((await codeDefs(engine, "zzNoSuchSymbol", undefined, ["tenant-c"])).readiness?.symbols).toBe(1);
    });

    it("ignores soft-deleted documents in both the lookup and the readiness", async () => {
      const r = await codeDefs(engine, "epsilon", undefined, ["tenant-e"]);
      expect(r.count).toBe(0);
      expect(r.readiness).toEqual({ state: "not_built", code_documents: 0, symbols: 0 });
      expect(await codeIndexReadiness(engine, ["tenant-e"], "edges"))
        .toEqual({ state: "not_built", code_documents: 0, symbols: 0 });
    });

    it("reports indexing only to callers whose sources the sweep walks", async () => {
      const { storage: fake, release } = blockingStorage();
      const run = sweepCodeRoots(fake, { paths: ["/tenant-a/"] });
      try {
        expect((await codeIndexReadiness(engine, ["tenant-a"])).state).toBe("indexing");
        expect((await codeIndexReadiness(engine, ["tenant-b", "tenant-a"])).state).toBe("indexing");
        expect((await codeIndexReadiness(engine, ["tenant-c"])).state).toBe("ready");
        expect((await codeIndexReadiness(engine)).state).toBe("indexing");
      } finally {
        release(false);
        await run;
      }
      expect((await codeIndexReadiness(engine, ["tenant-a"])).state).toBe("ready");
    });

    it("reports ready when the index is built and the symbol really is absent", async () => {
      const r = await codeDefs(engine, "zzNoSuchSymbol", undefined, ["tenant-a"]);
      expect(r.count).toBe(0);
      expect(r.readiness?.state).toBe("ready");
      expect(r.readiness?.code_documents).toBe(1);
      expect(r.readiness?.symbols).toBeGreaterThanOrEqual(2);
    });

    it("reports no_symbols when the indexed document has no definition mentions", async () => {
      const r = await codeDefs(engine, "alpha", undefined, ["tenant-d"]);
      expect(r.count).toBe(0);
      expect(r.readiness).toEqual({ state: "no_symbols", code_documents: 1, symbols: 0 });
    });

    it("leaves a non-empty result without a readiness key", async () => {
      const r = await codeDefs(engine, "alpha");
      expect(r.count).toBeGreaterThan(0);
      expect("readiness" in r).toBe(false);
    });

    it("counts every tenant for the operator", async () => {
      const r = await codeIndexReadiness(engine);
      expect(r.state).toBe("ready");
      // a, c and d — the soft-deleted e is not counted.
      expect(r.code_documents).toBe(3);
    });

    it("keeps another tenant's code out of a grant caller's readiness", async () => {
      const res = await dispatchTool(
        storage,
        { name: "code_def", arguments: { name: "alpha" } },
        {
          authInfo: {
            token: "tok-b",
            clientId: "client-b",
            scopes: ["read"],
            sourceId: "tenant-b",
            allowedSources: ["tenant-b"],
            isPublic: false,
          },
        },
      );
      expect(res.isError).toBeFalsy();
      const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
      const body = JSON.parse(text) as { count: number; readiness: unknown };
      expect(body.count).toBe(0);
      expect(body.readiness).toEqual({ state: "not_built", code_documents: 0, symbols: 0 });
      expect(text).not.toContain("tenant-a");
    });
  });
});
