/**
 * A page miss names the slug the caller most likely meant, drawn only from
 * pages that caller can read. The motivating failure: agents holding a write
 * source prefixed it onto slugs (`me/voicenotes/x` for `voicenotes/x`) and got
 * a bare "page not found" with nothing to recover from.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { affixCandidates } from "../src/core/slug-suggest.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

function auth(sourceId: string): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

const envelope = (r: ToolCallResult): any => JSON.parse(r.content[0]!.text);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-slug-suggest-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  await registerSource(e, { id: "me", kind: "vault", pathPrefix: "/tenant-me" });
  await registerSource(e, { id: "other", kind: "vault", pathPrefix: "/tenant-other" });
  await putPage(storage, { slug: "voicenotes/2026-09-16-qknc33j1", type: "note", markdown_body: "a", source_id: "me" });
  await putPage(storage, { slug: "notes/weekly-review", type: "note", markdown_body: "a", source_id: "me" });
  await putPage(storage, { slug: "life/diary/2026-09-16", type: "diary", markdown_body: "a", source_id: "me" });
  await putPage(storage, { slug: "notes/weekly-reviews", type: "note", markdown_body: "b", source_id: "other" });
  await putPage(storage, { slug: "voicenotes/2026-09-16-qknc33j2", type: "note", markdown_body: "b", source_id: "other" });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("affixCandidates", () => {
  it("strips a repeated write-source prefix and offers the prefixed form", () => {
    expect(affixCandidates("me/me/notes/x", "me")).toEqual(["me/notes/x", "notes/x"]);
    expect(affixCandidates("notes/x", "me")).toEqual(["me/notes/x"]);
    expect(affixCandidates("notes/x", undefined)).toEqual([]);
  });
});

describe("page not found suggestions", () => {
  it("suggests the slug with the caller's write-source prefix stripped", async () => {
    const r = await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "me/voicenotes/2026-09-16-qknc33j1" } },
      { authInfo: auth("me") },
    );
    expect(r.isError).toBe(true);
    const env = envelope(r);
    expect(env.error).toBe("not_found");
    expect(env.message).toBe("page not found: me/voicenotes/2026-09-16-qknc33j1");
    expect(env.suggestion).toMatch(/^Did you mean `voicenotes\/2026-09-16-qknc33j1`/);
  });

  it("strips a doubled prefix too", async () => {
    const r = await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "me/me/notes/weekly-review" } },
      { authInfo: auth("me") },
    );
    expect(envelope(r).suggestion).toMatch(/^Did you mean `notes\/weekly-review`/);
  });

  it("offers nearest slugs from the caller's own sources only", async () => {
    const r = await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "notes/weekly-revew" } },
      { authInfo: auth("me") },
    );
    const env = envelope(r);
    expect(env.suggestion).toContain("`notes/weekly-review`");
    expect(env.suggestion).not.toContain("weekly-reviews");

    const other = envelope(await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "voicenotes/2026-09-16-qknc33j9" } },
      { authInfo: auth("other") },
    ));
    expect(other.suggestion).toContain("`voicenotes/2026-09-16-qknc33j2`");
    expect(other.suggestion).not.toContain("qknc33j1");
  });

  it("never names a diary page to a remote caller", async () => {
    const env = envelope(await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "life/diary/2026-09-17" } },
      { authInfo: auth("me") },
    ));
    expect(env.error).toBe("not_found");
    expect(env.suggestion ?? "").not.toContain("diary");
  });

  it("gives the public bearer no slug suggestions", async () => {
    const env = envelope(await dispatchTool(
      storage,
      { name: "page_get", arguments: { slug: "notes/weekly-revew" } },
      { isPublic: true },
    ));
    expect(env.error).toBe("not_found");
    expect(env.message).toBeUndefined();
    expect(env.suggestion).toBeUndefined();
  });

  it("covers write-path misses: append, timeline, tag", async () => {
    const a = envelope(await dispatchTool(
      storage,
      { name: "page_append", arguments: { slug: "me/notes/weekly-review", content: "x" } },
      { authInfo: auth("me") },
    ));
    expect(a.error).toBe("not_found");
    expect(a.suggestion).toMatch(/^Did you mean `notes\/weekly-review`.*page_put/);

    const t = envelope(await dispatchTool(
      storage,
      { name: "add_timeline_event", arguments: { slug: "me/notes/weekly-review", occurred_at: "2026-09-16", event: "x" } },
      { authInfo: auth("me") },
    ));
    expect(t.error).toBe("not_found");
    expect(t.suggestion).toContain("`notes/weekly-review`");

    const g = envelope(await dispatchTool(
      storage,
      { name: "add_tag", arguments: { slug: "me/notes/weekly-review", tag: "x" } },
      { authInfo: auth("me") },
    ));
    expect(g.error).toBe("not_found");
    expect(g.suggestion).toContain("`notes/weekly-review`");
  });
});

describe("missing required arguments", () => {
  it("names the argument and lists the op's arguments with descriptions", async () => {
    const env = envelope(await dispatchTool(storage, { name: "page_append", arguments: { slug: "notes/x" } }, {}));
    expect(env.error).toBe("invalid_params");
    expect(env.message).toBe("page_append: `content` is required");
    expect(env.suggestion).toMatch(/^Required: `slug` \(string\); `content` \(string\)\. Optional: /);
    expect(env.suggestion).toContain("`request_id` (string): Optional retry id (1-128 chars), retained 7 days.");
    expect(env.suggestion).not.toContain("..");
  });

  it("treats an empty string as missing and reports every missing argument", async () => {
    const env = envelope(await dispatchTool(storage, { name: "link", arguments: { source_slug: "" } }, {}));
    expect(env.message).toBe("link: `source_slug`, `target_slug`, `type` are required");
  });
});
