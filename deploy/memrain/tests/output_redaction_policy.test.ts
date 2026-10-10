/**
 * Which tools get read-side redaction, and that dispatch applies it to every
 * caller but the operator.
 *
 * Every read-only tool returns stored text unless it is on the short exemption
 * list below (counts, names, config). A new read tool therefore has to opt out
 * here by name, or it is redacted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATIONS, operationAnnotations } from "../src/mcp/operations.ts";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";

const EXEMPT = new Set([
  "whoami",
  "get_brain_identity",
  "stats",
  "sources_list",
  "sources_status",
  "source_health",
  "get_tags",
  "list_skills",
  "resolve_slugs",
  "list_link_sources",
  "run_doctor",
]);

describe("outputRedaction policy", () => {
  it("every read tool outside the exemption list is redacted", () => {
    const missing = OPERATIONS.filter(
      (op) => operationAnnotations(op).readOnlyHint && !EXEMPT.has(op.name) && op.outputRedaction !== "retrieval",
    ).map((op) => op.name);
    expect(missing).toEqual([]);
  });

  it("the exempt tools exist, are read-only and carry no tag", () => {
    for (const name of EXEMPT) {
      const op = OPERATIONS.find((o) => o.name === name);
      expect({ name, found: !!op }).toEqual({ name, found: true });
      expect(operationAnnotations(op!).readOnlyHint).toBe(true);
      expect(op!.outputRedaction).toBeUndefined();
    }
  });

  it("no mutating tool is tagged", () => {
    const tagged = OPERATIONS.filter((op) => !operationAnnotations(op).readOnlyHint && op.outputRedaction).map(
      (op) => op.name,
    );
    expect(tagged).toEqual([]);
  });
});

const SOURCE = "redact-a";
const SLUG = "notes/leaky";
const GH = `gh${"p"}_${"y".repeat(36)}`;
const tenant: AuthInfo = {
  token: "tok-redact",
  clientId: "client-redact",
  scopes: ["read"],
  sourceId: SOURCE,
  allowedSources: [SOURCE],
  isPublic: false,
};

let tmp: string;
let storage: Storage;
const savedDisposition = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
const savedSwitch = process.env.MEMRAIN_OUTPUT_REDACTION;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-output-redaction-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: SOURCE, kind: "vault", pathPrefix: "/redact-a" });
  // `flag` stores the credential as written: the text a pre-scan brain holds.
  process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
  await putPage(storage, { slug: SLUG, type: "note", title: "Leaky", markdown_body: `token ${GH}`, source_id: SOURCE });
  if (savedDisposition === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = savedDisposition;
});

afterAll(async () => {
  if (savedSwitch === undefined) delete process.env.MEMRAIN_OUTPUT_REDACTION;
  else process.env.MEMRAIN_OUTPUT_REDACTION = savedSwitch;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function payload(r: ToolCallResult): any {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text);
}

describe("dispatchTool output redaction", () => {
  it("redacts page_get for a tenant, keeping slug and version", async () => {
    const out = payload(await dispatchTool(storage, { name: "page_get", arguments: { slug: SLUG } }, { authInfo: tenant }));
    expect(out.page.markdown_body).toContain("[REDACTED:github-token:");
    expect(out.page.markdown_body).not.toContain(GH);
    expect(out.page.slug).toBe(SLUG);
    expect(out.version).toBe(1);
    expect(out.redacted_secrets).toBe(1);
  });

  it("returns the operator's page raw", async () => {
    const out = payload(await dispatchTool(storage, { name: "page_get", arguments: { slug: SLUG } }));
    expect(out.page.markdown_body).toBe(`token ${GH}`);
    expect(out.redacted_secrets).toBeUndefined();
  });

  it("redacts page_versions and page_list for a tenant", async () => {
    for (const [name, args] of [
      ["page_versions", { slug: SLUG }],
      ["page_list", {}],
    ] as const) {
      const r = await dispatchTool(storage, { name, arguments: args }, { authInfo: tenant });
      expect(r.content[0]!.text).not.toContain(GH);
    }
  });

  it("MEMRAIN_OUTPUT_REDACTION=0 turns it off", async () => {
    process.env.MEMRAIN_OUTPUT_REDACTION = "0";
    try {
      const out = payload(await dispatchTool(storage, { name: "page_get", arguments: { slug: SLUG } }, { authInfo: tenant }));
      expect(out.page.markdown_body).toBe(`token ${GH}`);
    } finally {
      delete process.env.MEMRAIN_OUTPUT_REDACTION;
    }
  });
});
