/**
 * Slug redirects (migration 067) — resolver, setter, and the getPage +
 * slug-canonicalize wiring.
 *
 * PGLite-backed Storage per test; no Bedrock, no HTTP.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { resolveSlugWithAlias, setSlugAlias } from "../src/core/slug-aliases.ts";
import { makeSlugResolver } from "../src/core/slug-canonicalize.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-slugalias-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveSlugWithAlias", () => {
  it("returns the input slug unchanged on a miss", async () => {
    expect(await resolveSlugWithAlias(storage, "people/nobody")).toBe(
      "people/nobody",
    );
  });

  it("forwards a registered redirect to its canonical slug", async () => {
    await putPage(storage, { slug: "people/robert", type: "person" });
    await setSlugAlias(storage.engine(), {
      alias_slug: "people/bob",
      canonical_slug: "people/robert",
    });
    expect(await resolveSlugWithAlias(storage, "people/bob")).toBe(
      "people/robert",
    );
  });

  it("scopes resolution to the caller's sources", async () => {
    await putPage(storage, { slug: "companies/acme", type: "company" });
    await setSlugAlias(storage.engine(), {
      alias_slug: "acme",
      canonical_slug: "companies/acme",
      source_id: "tenant-a",
    });
    // Wrong tenant -> no redirect.
    expect(await resolveSlugWithAlias(storage, "acme", ["tenant-b"])).toBe(
      "acme",
    );
    // Right tenant -> redirect.
    expect(await resolveSlugWithAlias(storage, "acme", ["tenant-a"])).toBe(
      "companies/acme",
    );
  });

  it("collapses a chain so a single hop always suffices", async () => {
    // a -> b, then rename b -> c should re-point a -> c.
    await putPage(storage, { slug: "c", type: "note" });
    await setSlugAlias(storage.engine(), { alias_slug: "a", canonical_slug: "b" });
    await setSlugAlias(storage.engine(), { alias_slug: "b", canonical_slug: "c" });
    expect(await resolveSlugWithAlias(storage, "a")).toBe("c");
    expect(await resolveSlugWithAlias(storage, "b")).toBe("c");
  });

  it("refuses a self-redirect", async () => {
    await expect(
      setSlugAlias(storage.engine(), { alias_slug: "x", canonical_slug: "x" }),
    ).rejects.toThrow(/must differ/);
  });
});

describe("getPage redirect", () => {
  it("resolves an old slug to the live page via the redirect", async () => {
    await putPage(storage, { slug: "people/robert", type: "person", markdown_body: "hi" });
    await setSlugAlias(storage.engine(), {
      alias_slug: "people/bob",
      canonical_slug: "people/robert",
    });
    const page = await getPage(storage, "people/bob");
    expect(page?.slug).toBe("people/robert");
    expect(page?.markdown_body).toBe("hi");
  });

  it("does not redirect when the exact page exists (hot path)", async () => {
    await putPage(storage, { slug: "people/bob", type: "person", markdown_body: "live" });
    await putPage(storage, { slug: "people/robert", type: "person", markdown_body: "other" });
    // A redirect exists but the exact slug is live -> exact wins, no forward.
    await setSlugAlias(storage.engine(), {
      alias_slug: "people/bob",
      canonical_slug: "people/robert",
    });
    const page = await getPage(storage, "people/bob");
    expect(page?.markdown_body).toBe("live");
  });
});

describe("slug-canonicalize redirect stage", () => {
  it("short-circuits the fuzzy cascade with a redirect", async () => {
    await putPage(storage, { slug: "people/robert", type: "person" });
    await setSlugAlias(storage.engine(), {
      alias_slug: "bob",
      canonical_slug: "people/robert",
    });
    const resolver = makeSlugResolver(storage, "notes/source");
    const r = await resolver.resolve("Bob");
    expect(r.stage).toBe("redirect");
    expect(r.slug).toBe("people/robert");
    expect(r.resolved).toBe(true);
  });
});
