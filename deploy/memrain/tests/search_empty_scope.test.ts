/**
 * A caller granted no source (`sourceIds: []`) must read nothing from hybrid
 * search — on every arm, on both cache arms, and without spending an embedding.
 * `undefined` (the operator) still reads the whole brain.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { indexPageIntoSearch } from "../src/core/page-index.ts";
import { hybridSearch } from "../src/core/search/hybrid.ts";
import { NO_SOURCE_SENTINEL } from "../src/core/auth-info.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(30000);

const TOKEN = "WombatSecretZZZ";
const TITLE = "Wombat Ledger Quarterly";

let tmp: string;
let storage: Storage;
let embedCalls = 0;
const embedFn = async (text: string) => {
  embedCalls++;
  return deterministicEmbed(text);
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-empty-scope-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: "b", kind: "vault", pathPrefix: "/tenant-b" });
  const page = { slug: "notes/wombat-ledger", title: TITLE, markdown_body: `wombat ${TOKEN}`, source_id: "b" };
  await putPage(storage, { ...page, type: "note" });
  await indexPageIntoSearch(storage, page, { embedFn });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("hybridSearch with no grant", () => {
  for (const [label, scope] of [["[]", []], ["sentinel", [NO_SOURCE_SENTINEL]]] as const) {
    it(`returns nothing for ${label} on the keyword and vector arms`, async () => {
      embedCalls = 0;
      for (const q of ["wombat", TITLE]) {
        const hits = await hybridSearch(storage, q, { k: 10, sourceIds: scope, embedQuery: embedFn });
        expect(JSON.stringify(hits)).not.toContain(TOKEN);
        expect(hits).toEqual([]);
      }
      expect(embedCalls).toBe(0);
    });
  }



  it("still serves the operator the whole brain", async () => {
    const hits = await hybridSearch(storage, "wombat", { k: 10, embedQuery: embedFn });
    expect(JSON.stringify(hits)).toContain(TOKEN);
  });
});
