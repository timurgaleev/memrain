/**
 * The extraction watermark follows the extractor switches: turning one on or
 * off makes every page stale once, a brain's first record marks nothing, and
 * the sweep's stamp clears the raised watermark.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { countStalePagesForExtraction, LINK_EXTRACTOR_VERSION_TS } from "../src/core/links.ts";
import { LINK_FLAGS_GENERATION_KEY, linkFlagsHash, syncLinkFlagsGeneration } from "../src/core/link-watermark.ts";
import { extractStaleLinks } from "../src/core/links-stale-sweep.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-link-wm-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

const OFF = {};
const VERB_ON = { MEMRAIN_LINK_VERB_INFER: "1" };

describe("link extraction watermark", () => {
  it("hashes the three switches and nothing else", () => {
    expect(linkFlagsHash(OFF)).toBe(linkFlagsHash({ MEMRAIN_UNRELATED: "1" }));
    expect(linkFlagsHash(VERB_ON)).not.toBe(linkFlagsHash(OFF));
    expect(linkFlagsHash({ MEMRAIN_GAZETTEER: "1" })).not.toBe(linkFlagsHash({ MEMRAIN_TYPED_LINKS: "1" }));
  });

  it("re-stales extracted pages when a switch changes, and the sweep clears them", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "notes/a", markdown_body: "hi" });
    await putPage(storage, { slug: "notes/b", markdown_body: "ho" });
    await extractStaleLinks(storage, { quiet: true });
    expect(await countStalePagesForExtraction(e)).toBe(0);

    // First record: dated at the code watermark, nothing goes stale.
    expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, OFF, true)).toEqual({ changed: false });
    expect(await countStalePagesForExtraction(e)).toBe(0);
    expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, OFF, true)).toEqual({ changed: false });

    // Doctor passes the code constant explicitly; it must see the raise too.
    expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, VERB_ON, true)).toEqual({ changed: true });
    expect(await countStalePagesForExtraction(e, { versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);

    const swept = await extractStaleLinks(storage, { quiet: true });
    expect(swept.pagesProcessed).toBe(2);
    expect(swept.staleRemaining).toBe(0);
    expect(await countStalePagesForExtraction(e)).toBe(0);
  });

  it("a process that is not the server's cycle loop compares and never moves the generation", async () => {
    const e = storage.engine();
    await putPage(storage, { slug: "notes/a", markdown_body: "hi" });
    await extractStaleLinks(storage, { quiet: true });
    expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, OFF, true)).toEqual({ changed: false });
    const before = await e.query<{ value: string; updated_at: string }>(
      `SELECT value, updated_at::text AS updated_at FROM config WHERE key = $1`,
      [LINK_FLAGS_GENERATION_KEY],
    );

    // A shell `memrain cycle` with other switches, alternating with the loop.
    for (let i = 0; i < 2; i++) {
      expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, VERB_ON)).toEqual({ changed: false });
      expect(await syncLinkFlagsGeneration(e, LINK_EXTRACTOR_VERSION_TS, OFF, true)).toEqual({ changed: false });
    }
    const after = await e.query<{ value: string; updated_at: string }>(
      `SELECT value, updated_at::text AS updated_at FROM config WHERE key = $1`,
      [LINK_FLAGS_GENERATION_KEY],
    );
    expect(after.rows).toEqual(before.rows);
    expect(await countStalePagesForExtraction(e)).toBe(0);
  });
});
