/**
 * Page tags — CRUD over the migration-023 `tags` table.
 *
 * Covers normalization, idempotent add/remove, page-existence enforcement,
 * soft-delete handling, and the lexical read order.
 *
 * Uses a fresh PGLite-backed Storage per test — no Bedrock, no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { addTag, getTags, normalizeTag, removeTag } from "../src/core/tags.ts";
import { registerSource } from "../src/core/sources.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-tags-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await putPage(storage, { slug: "alice", type: "person", title: "Alice" });
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// normalizeTag
// ---------------------------------------------------------------------------

describe("normalizeTag", () => {
  it("trims, collapses whitespace, lowercases", () => {
    expect(normalizeTag("  Foo  Bar ")).toBe("foo bar");
    expect(normalizeTag("IDEA")).toBe("idea");
  });

  it("returns empty for non-string / blank", () => {
    expect(normalizeTag(42)).toBe("");
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag(null)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// addTag / getTags
// ---------------------------------------------------------------------------

describe("addTag + getTags", () => {
  it("adds a tag and reads it back", async () => {
    await addTag(storage, "alice", "friend");
    expect(await getTags(storage, "alice")).toEqual(["friend"]);
  });

  it("normalizes before storing", async () => {
    await addTag(storage, "alice", "  Colleague ");
    expect(await getTags(storage, "alice")).toEqual(["colleague"]);
  });

  it("is idempotent — re-adding the same tag is a no-op", async () => {
    await addTag(storage, "alice", "friend");
    await addTag(storage, "alice", "friend");
    await addTag(storage, "alice", "FRIEND"); // collapses to same key
    expect(await getTags(storage, "alice")).toEqual(["friend"]);
  });

  it("returns tags in lexical order", async () => {
    await addTag(storage, "alice", "zebra");
    await addTag(storage, "alice", "apple");
    await addTag(storage, "alice", "mango");
    expect(await getTags(storage, "alice")).toEqual(["apple", "mango", "zebra"]);
  });

  it("rejects an empty tag", async () => {
    await expect(addTag(storage, "alice", "   ")).rejects.toThrow(/non-empty/);
  });

  it("rejects an over-length tag", async () => {
    await expect(
      addTag(storage, "alice", "x".repeat(129)),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects tagging a non-existent page", async () => {
    await expect(addTag(storage, "ghost", "friend")).rejects.toThrow(
      /page not found: ghost/,
    );
  });

  it("rejects tagging a soft-deleted page", async () => {
    await deletePage(storage, "alice");
    await expect(addTag(storage, "alice", "friend")).rejects.toThrow(
      /not found/,
    );
  });

  it("rejects a missing slug", async () => {
    await expect(addTag(storage, "", "friend")).rejects.toThrow(/slug/);
  });
});

// ---------------------------------------------------------------------------
// removeTag
// ---------------------------------------------------------------------------

describe("removeTag", () => {
  it("removes an existing tag", async () => {
    await addTag(storage, "alice", "friend");
    await addTag(storage, "alice", "colleague");
    await removeTag(storage, "alice", "friend");
    expect(await getTags(storage, "alice")).toEqual(["colleague"]);
  });

  it("is idempotent — removing an absent tag is a no-op", async () => {
    await addTag(storage, "alice", "friend");
    await removeTag(storage, "alice", "missing");
    await removeTag(storage, "alice", "missing");
    expect(await getTags(storage, "alice")).toEqual(["friend"]);
  });

  it("normalizes before deleting", async () => {
    await addTag(storage, "alice", "friend");
    await removeTag(storage, "alice", "  FRIEND ");
    expect(await getTags(storage, "alice")).toEqual([]);
  });

  it("is a no-op on a non-existent page", async () => {
    await expect(removeTag(storage, "ghost", "friend")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getTags
// ---------------------------------------------------------------------------

describe("getTags", () => {
  it("returns [] for an untagged page", async () => {
    expect(await getTags(storage, "alice")).toEqual([]);
  });

  it("returns [] for an unknown page", async () => {
    expect(await getTags(storage, "ghost")).toEqual([]);
  });

  it("scopes tags to the requested page", async () => {
    await putPage(storage, { slug: "bob", type: "person" });
    await addTag(storage, "alice", "friend");
    await addTag(storage, "bob", "colleague");
    expect(await getTags(storage, "alice")).toEqual(["friend"]);
    expect(await getTags(storage, "bob")).toEqual(["colleague"]);
  });
});

// ---------------------------------------------------------------------------
// credentials in tag text
// ---------------------------------------------------------------------------

describe("tag secrets", () => {
  const GH = `gh${"p"}_${"t".repeat(36)}`;

  it("addTag never stores a credential", async () => {
    await addTag(storage, "alice", `key ${GH}`);
    const tags = await getTags(storage, "alice");
    expect(tags).toHaveLength(1);
    expect(tags[0]).not.toContain(GH);
    expect(tags[0]).toContain("redacted");
  });

  it("get_tags redacts a stored credential for a tenant and not for the operator", async () => {
    await registerSource(storage.engine(), { id: "tags-a", kind: "vault", pathPrefix: "/tags-a" });
    await putPage(storage, { slug: "team/doc", markdown_body: "doc", source_id: "tags-a" });
    // A tag written before add_tag scanned its text.
    await storage.engine().query(`INSERT INTO tags (slug, tag, source_id) VALUES ($1, $2, $3)`, [
      "team/doc",
      `key ${GH}`,
      "tags-a",
    ]);
    const tenant: AuthInfo = {
      token: "tok-tags",
      clientId: "client-tags",
      scopes: ["read"],
      sourceId: "tags-a",
      allowedSources: ["tags-a"],
      isPublic: false,
    };
    const scoped = await dispatchTool(storage, { name: "get_tags", arguments: { slug: "team/doc" } }, { authInfo: tenant });
    expect(scoped.isError).toBeFalsy();
    expect(scoped.content[0]!.text).not.toContain(GH);
    const operator = await dispatchTool(storage, { name: "get_tags", arguments: { slug: "team/doc" } });
    expect(operator.content[0]!.text).toContain(GH);
  });
});
