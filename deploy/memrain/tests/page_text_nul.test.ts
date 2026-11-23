/**
 * Page and timeline text holding U+0000 is stored with that character removed
 * instead of failing the whole write (Postgres text and jsonb cannot hold it).
 * The removal happens before the secret scan, so a NUL inside a credential
 * cannot hide it from the scanner.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { appendPage, getPage, putPage } from "../src/core/pages.ts";

const NUL = "\u0000";
const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-nul-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("a page write with U+0000 in its text", () => {
  it("stores body and title with U+0000 removed and every other character kept, and logs the count", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await putPage(storage, {
        slug: "notes/chat-canapes",
        title: `Chat about canap${NUL}es`,
        markdown_body: `alice said: canap${NUL}es, then ${NUL}${NUL}twice.`,
      });
      expect(r.created).toBe(true);
      const page = await getPage(storage, "notes/chat-canapes");
      expect(page!.title).toBe("Chat about canapes");
      expect(page!.markdown_body).toBe("alice said: canapes, then twice.");
      expect(warn.mock.calls.some(([m]) => String(m).includes("[nul_removed]") && String(m).includes("notes/chat-canapes") && String(m).includes("4"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("stores appended and edited text with U+0000 removed", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    await appendPage(storage, { slug: "notes/log", content: `more canap${NUL}es` });
    await putPage(storage, { slug: "notes/log", edits: [{ old_text: "start", new_text: `begin${NUL}ning` }] });
    expect((await getPage(storage, "notes/log"))!.markdown_body).toBe("beginning\nmore canapes");
  });

  it("refuses an edit whose old_text holds U+0000 as edit_no_match", async () => {
    await putPage(storage, { slug: "notes/sel", markdown_body: "then thrice" });
    await expect(putPage(storage, { slug: "notes/sel", edits: [{ old_text: `the${NUL}n thrice`, new_text: "never" }] }))
      .rejects.toMatchObject({ code: "edit_no_match" });
    expect((await getPage(storage, "notes/sel"))!.markdown_body).toBe("then thrice");
  });

  it("still finds a credential split by U+0000", async () => {
    const split = `${AWS.slice(0, 8)}${NUL}${AWS.slice(8)}`;
    const r = await putPage(storage, { slug: "notes/env", markdown_body: `key ${split}` });
    expect(r.secrets_found).toBe(1);
    const body = (await getPage(storage, "notes/env"))!.markdown_body;
    expect(body).not.toContain(AWS);
    expect(body).not.toContain(NUL);
  });
});

