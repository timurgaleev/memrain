/**
 * A page the content-sanity gate quarantined: page_put / page_append report
 * it, and page_get withholds its body from every caller but the operator and
 * an admin who asks for it with include_quarantined.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { registerSource } from "../src/core/sources.ts";

const SOURCE = "quar-a";
const JUNK = "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d";
const CLEAN = "A perfectly normal note about the quarterly retrieval plan.";

const reader: AuthInfo = {
  token: "tok-quar-r",
  clientId: "client-quar-r",
  scopes: ["read", "write"],
  sourceId: SOURCE,
  allowedSources: [SOURCE],
  isPublic: false,
};
const admin: AuthInfo = { ...reader, token: "tok-quar-a", clientId: "client-quar-a", scopes: ["read", "write", "admin"] };

let tmp: string;
let storage: Storage;

function payload(r: ToolCallResult): any {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text);
}

const call = async (name: string, args: Record<string, unknown>, authInfo?: AuthInfo) =>
  payload(await dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {}));

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-page-get-quarantined-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: SOURCE, kind: "vault", pathPrefix: "/quar-a" });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("write responses carry the verdict", () => {
  it("page_put reports quarantined for junk and nothing for a clean page", async () => {
    const junk = await call("page_put", { slug: "notes/junk", type: "note", markdown_body: JUNK }, reader);
    expect(junk.quarantined).toEqual({ reason: "junk_pattern", detail: expect.stringContaining("cloudflare_ray_id") });
    const clean = await call("page_put", { slug: "notes/clean", type: "note", markdown_body: CLEAN }, reader);
    expect(clean.quarantined).toBeUndefined();
  });

  it("page_append reports quarantined when the appended page is junk", async () => {
    await call("page_put", { slug: "notes/grows", type: "note", markdown_body: "Short." }, reader);
    const r = await call("page_append", { slug: "notes/grows", content: JUNK }, reader);
    expect(r.quarantined?.reason).toBe("junk_pattern");
  });
});

describe("page_get on a quarantined page", () => {
  it("a tenant gets the page without its body and a notice", async () => {
    const r = await call("page_get", { slug: "notes/junk" }, reader);
    expect(r.notice).toBe("page_quarantined");
    expect(r.quarantined.reason).toBe("junk_pattern");
    expect(r.page.slug).toBe("notes/junk");
    expect(r.page.markdown_body).toBeUndefined();
    expect(r.page.compiled_truth).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("Checking your browser");
    expect(r.version).toBe(1);
  });

  it("include_quarantined without the admin scope changes nothing", async () => {
    const r = await call("page_get", { slug: "notes/junk", include_quarantined: true }, reader);
    expect(r.notice).toBe("page_quarantined");
    expect(r.page.markdown_body).toBeUndefined();
  });

  it("an admin who asks gets the body and the verdict", async () => {
    const r = await call("page_get", { slug: "notes/junk", include_quarantined: true }, admin);
    expect(r.page.markdown_body).toBe(JUNK);
    expect(r.quarantined.reason).toBe("junk_pattern");
    expect(r.notice).toBeUndefined();
  });

  it("an admin who does not ask is withheld like anyone else", async () => {
    const r = await call("page_get", { slug: "notes/junk" }, admin);
    expect(r.notice).toBe("page_quarantined");
  });

  it("the operator gets the body and the verdict", async () => {
    const r = await call("page_get", { slug: "notes/junk" });
    expect(r.page.markdown_body).toBe(JUNK);
    expect(r.quarantined.reason).toBe("junk_pattern");
    expect(r.notice).toBeUndefined();
  });

  it("a clean page carries neither field", async () => {
    const r = await call("page_get", { slug: "notes/clean" }, reader);
    expect(r.page.markdown_body).toBe(CLEAN);
    expect(r.quarantined).toBeUndefined();
    expect(r.notice).toBeUndefined();
  });
});
