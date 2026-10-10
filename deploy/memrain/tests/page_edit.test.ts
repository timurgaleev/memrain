/**
 * page_edit: exact-text replacements under the slug lock, through the real
 * dispatchTool path over PGLite. Covers the match rules (once, in order, all
 * or nothing), the protected facts/takes fences, the version precondition,
 * the secret guard on new_text, tenant and slug-prefix scoping, the public
 * ingress, and the diff the response carries.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { registerSource } from "../src/core/sources.ts";
import { getPage, pageVersions, putPage } from "../src/core/pages.ts";
import { boundedDiff, PAGE_EDIT_DIFF_MAX_BYTES, parsePageEdits, unifiedDiff } from "../src/core/page-edit.ts";
import { isPublicMcpToolForbidden } from "../src/http/public_guard.ts";
import { dispatchRefusal } from "../src/mcp/visibility.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

setDefaultTimeout(60000);
let tmp: string;
let storage: Storage;

const A = "edit-a";
const B = "edit-b";
const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
const FACTS = "<!--- memrain:facts:begin -->\n| fact |\n|---|\n| Alice likes tea |\n<!--- memrain:facts:end -->";

function auth(sourceId: string, extra: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes: ["read", "write"],
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
    ...extra,
  };
}

function payload(result: ToolCallResult): any {
  return JSON.parse(result.content[0]!.text);
}

async function edit(
  args: Record<string, unknown>,
  opts: { authInfo?: AuthInfo; isPublic?: boolean } = {},
): Promise<ToolCallResult> {
  return dispatchTool(storage, { name: "page_edit", arguments: args }, opts);
}

async function version(slug: string): Promise<number> {
  return payload(await dispatchTool(storage, { name: "page_get", arguments: { slug } })).version;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-page-edit-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/edit-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/edit-b" });
});
afterEach(async () => {
  delete process.env["MEMRAIN_PUBLIC_WRITE"];
  delete process.env["MEMRAIN_PUBLIC_READ_BODIES"];
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("page_edit applies exact replacements", () => {
  it("replaces each old_text once, in order, keeps title and truth, and returns a diff", async () => {
    await putPage(storage, {
      slug: "notes/plan",
      title: "Plan",
      compiled_truth: { tier: 2 },
      markdown_body: "# Plan\n\nStatus: draft\nOwner: Bob\n",
    });
    const r = payload(await edit({
      slug: "notes/plan",
      expected_version: 1,
      edits: [
        { old_text: "Status: draft", new_text: "Status: final" },
        { old_text: "final", new_text: "shipped" },
      ],
    }));
    expect(r).toMatchObject({ ok: true, slug: "notes/plan", version: 2, changed: true, edits_applied: 2 });
    expect(r.diff).toContain("-Status: draft");
    expect(r.diff).toContain("+Status: shipped");
    expect(r.diff).not.toContain("Owner: Bob\n-");
    const page = await getPage(storage, "notes/plan");
    expect(page!.markdown_body).toBe("# Plan\n\nStatus: shipped\nOwner: Bob\n");
    expect(page!.title).toBe("Plan");
    expect(page!.compiled_truth).toEqual({ tier: 2 });
  });

  it("writes nothing when a later edit fails", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "one two" });
    const r = await edit({
      slug: "notes/a",
      expected_version: 1,
      edits: [{ old_text: "one", new_text: "1" }, { old_text: "three", new_text: "3" }],
    });
    expect(r.isError).toBe(true);
    expect(payload(r)).toMatchObject({ error: "edit_no_match", edit_index: 1, match_count: 0 });
    expect((await getPage(storage, "notes/a"))!.markdown_body).toBe("one two");
    expect(await version("notes/a")).toBe(1);
  });

  it("refuses an ambiguous old_text with its match count", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "x and x" });
    const r = await edit({ slug: "notes/a", expected_version: 1, edits: [{ old_text: "x", new_text: "y" }] });
    expect(payload(r)).toMatchObject({ error: "edit_ambiguous_match", edit_index: 0, match_count: 2 });
  });

  it("requires expected_version and refuses a stale one with the current version", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "v1" });
    await putPage(storage, { slug: "notes/a", markdown_body: "v2" });
    const missing = await edit({ slug: "notes/a", edits: [{ old_text: "v2", new_text: "v3" }] });
    expect(payload(missing).error).toBe("invalid_params");
    const stale = await edit({ slug: "notes/a", expected_version: 1, edits: [{ old_text: "v2", new_text: "v3" }] });
    expect(payload(stale)).toMatchObject({ error: "version_conflict", current_version: 2 });
    expect((await getPage(storage, "notes/a"))!.markdown_body).toBe("v2");
  });

  it("is not a create: a missing page reads as not found", async () => {
    const r = await edit({ slug: "notes/none", expected_version: 1, edits: [{ old_text: "a", new_text: "b" }] });
    expect(payload(r).error).toBe("not_found");
  });

  it("validates the edits array shape", async () => {
    expect(() => parsePageEdits([])).toThrow();
    expect(() => parsePageEdits(Array.from({ length: 51 }, () => ({ old_text: "a", new_text: "b" })))).toThrow();
    expect(() => parsePageEdits([{ old_text: "", new_text: "b" }])).toThrow();
    expect(() => parsePageEdits([{ old_text: "a", new_text: "b", extra: 1 }])).toThrow();
    expect(() => parsePageEdits([{ old_text: "a" }])).toThrow();
  });
});

describe("protected fences", () => {
  it("refuses an old_text inside or across a facts fence and leaves the page alone", async () => {
    await putPage(storage, { slug: "people/alice", markdown_body: `Intro\n\n${FACTS}\n\nOutro` });
    for (const oldText of ["Alice likes tea", "Intro\n\n<!--- memrain:facts:begin -->"]) {
      const r = await edit({ slug: "people/alice", expected_version: 1, edits: [{ old_text: oldText, new_text: "x" }] });
      expect(payload(r).error).toBe("edit_protected_span");
    }
    expect((await getPage(storage, "people/alice"))!.markdown_body).toBe(`Intro\n\n${FACTS}\n\nOutro`);
  });

  it("edits ordinary text around a fence without moving it", async () => {
    await putPage(storage, { slug: "people/alice", markdown_body: `Intro\n\n${FACTS}\n\nOutro` });
    const r = await edit({ slug: "people/alice", expected_version: 1, edits: [{ old_text: "Outro", new_text: "Closing" }] });
    expect(payload(r).ok).toBe(true);
    expect((await getPage(storage, "people/alice"))!.markdown_body).toBe(`Intro\n\n${FACTS}\n\nClosing`);
  });

  it("refuses edits that assemble a fence marker between them", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "start\nend" });
    const r = await edit({
      slug: "notes/a",
      expected_version: 1,
      edits: [
        { old_text: "start", new_text: "<!--- memrain:facts:begin -X" },
        { old_text: "X", new_text: "->" },
      ],
    });
    expect(payload(r).error).toBe("edit_protected_span");
    expect((await getPage(storage, "notes/a"))!.markdown_body).toBe("start\nend");
  });

  it("refuses a new_text that writes a fence marker of either brand", async () => {
    await putPage(storage, { slug: "notes/a", markdown_body: "plain" });
    for (const marker of ["<!--- memrain:takes:begin -->", "<!--- memex:facts:end -->"]) {
      const r = await edit({ slug: "notes/a", expected_version: 1, edits: [{ old_text: "plain", new_text: marker }] });
      expect(payload(r).error).toBe("edit_protected_span");
    }
  });
});

describe("write guards", () => {
  it("redacts a credential in new_text", async () => {
    await putPage(storage, { slug: "notes/env", markdown_body: "key: TODO" });
    const r = payload(await edit({ slug: "notes/env", expected_version: 1, edits: [{ old_text: "TODO", new_text: AWS }] }));
    expect(r.secrets_found).toBe(1);
    expect(r.diff).not.toContain(AWS);
    expect((await getPage(storage, "notes/env"))!.markdown_body).not.toContain(AWS);
  });

  it("cannot reach another source's page, which reads as not found", async () => {
    await putPage(storage, { slug: "team-b/doc", markdown_body: "secret plan", source_id: B });
    const r = await edit(
      { slug: "team-b/doc", expected_version: 1, edits: [{ old_text: "secret", new_text: "public" }] },
      { authInfo: auth(A) },
    );
    expect(payload(r).error).toBe("not_found");
    expect((await getPage(storage, "team-b/doc"))!.markdown_body).toBe("secret plan");
  });

  it("edits the caller's own page and stamps its principal", async () => {
    await putPage(storage, { slug: "team-a/doc", markdown_body: "draft", source_id: A });
    const r = payload(await edit(
      { slug: "team-a/doc", expected_version: 1, edits: [{ old_text: "draft", new_text: "done" }], written_by: "operator" },
      { authInfo: auth(A) },
    ));
    expect(r.ok).toBe(true);
    const [top] = await pageVersions(storage, "team-a/doc", 1, undefined, { withPrincipal: true });
    expect(top!.written_by_principal).toBe(`client:client-${A}`);
  });

  it("cannot read a page outside the caller's read grant through the matcher or the diff", async () => {
    await putPage(storage, { slug: "team-b/doc", markdown_body: "secret plan", source_id: B });
    // Writes to B but reads only A.
    const writeOnly = await edit(
      { slug: "team-b/doc", expected_version: 1, edits: [{ old_text: "secret", new_text: "public" }] },
      { authInfo: auth(B, { allowedSources: [A] }) },
    );
    expect(payload(writeOnly).error).toBe("not_found");
    // Reads A, no write source: refused before any page is looked up.
    const noWriteSource = await edit(
      { slug: "team-b/doc", expected_version: 1, edits: [{ old_text: "secret", new_text: "public" }] },
      { authInfo: auth(A, { sourceId: undefined }) },
    );
    expect(payload(noWriteSource).error).toBe("permission_denied");
    expect((await getPage(storage, "team-b/doc"))!.markdown_body).toBe("secret plan");
  });

  it("scans the edited body, not only each new_text", async () => {
    const [head, tail] = [AWS.slice(0, 8), AWS.slice(8)];
    await putPage(storage, { slug: "notes/split", markdown_body: `key: ${head}@@` });
    const r = payload(await edit({ slug: "notes/split", expected_version: 1, edits: [{ old_text: "@@", new_text: tail }] }));
    expect(r.secrets_found).toBeGreaterThanOrEqual(1);
    expect((await getPage(storage, "notes/split"))!.markdown_body).not.toContain(AWS);
  });

  it("holds a slug-bound client to its prefixes", async () => {
    await putPage(storage, { slug: "team-a/other/doc", markdown_body: "draft", source_id: A });
    const r = await edit(
      { slug: "team-a/other/doc", expected_version: 1, edits: [{ old_text: "draft", new_text: "done" }] },
      { authInfo: auth(A, { boundSlugPrefixes: ["team-a/mine"] }) },
    );
    expect(payload(r).error).toBe("permission_denied");
    expect(dispatchRefusal("page_edit", auth(A, { boundSlugPrefixes: ["team-a/mine"] }))).toBeNull();
  });

  it("follows page_put on the public ingress, and needs readable bodies there", async () => {
    expect(isPublicMcpToolForbidden("page_edit")).toBe(true);
    process.env["MEMRAIN_PUBLIC_WRITE"] = "1";
    expect(isPublicMcpToolForbidden("page_edit")).toBe(isPublicMcpToolForbidden("page_put"));
    await putPage(storage, { slug: "notes/pub", markdown_body: "hidden words" });
    const r = await edit(
      { slug: "notes/pub", expected_version: 1, edits: [{ old_text: "hidden", new_text: "x" }] },
      { isPublic: true },
    );
    // A matcher would otherwise tell a body-redacted caller what the page says.
    expect(payload(r).error).toBe("permission_denied");
    expect((await getPage(storage, "notes/pub"))!.markdown_body).toBe("hidden words");
  });
});

describe("diff", () => {
  it("is a unified diff with context and hunk headers", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const after = "a\nb\nc\nD\ne\nf\ng\nh\n";
    expect(unifiedDiff(before, after, "x.md")).toBe(
      "--- a/x.md\n+++ b/x.md\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n",
    );
  });

  it("is cut on a line boundary at 8 KB and says so", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace(/line (\d+)/g, "LINE $1");
    const d = boundedDiff(before, after, "big.md");
    expect(d.diff_truncated).toBe(true);
    expect(Buffer.byteLength(d.diff)).toBeLessThanOrEqual(PAGE_EDIT_DIFF_MAX_BYTES);
    expect(d.diff.endsWith("\n")).toBe(true);
  });
});

describe("callers with no write source", () => {
  const sourceless = (extra: Partial<AuthInfo> = {}): AuthInfo => ({
    token: "tok-sourceless",
    clientId: "client-sourceless",
    scopes: ["read", "write"],
    isPublic: false,
    ...extra,
  });

  it("refuses an authenticated client that holds no write source, whatever page it names", async () => {
    // MEMRAIN_TENANT_FAIL_CLOSED unset: such a client is let through the tool
    // gate, and must not fall through to an unscoped write.
    await putPage(storage, { slug: "team-b/doc", markdown_body: "secret plan", source_id: B });
    await putPage(storage, { slug: "notes/shared", markdown_body: "draft" });
    for (const [slug, oldText] of [["team-b/doc", "secret"], ["notes/shared", "draft"]] as const) {
      const r = await edit(
        { slug, expected_version: 1, edits: [{ old_text: oldText, new_text: "x" }] },
        { authInfo: sourceless() },
      );
      expect(r.isError).toBe(true);
      expect(payload(r).error).toBe("permission_denied");
      expect(payload(r).message).toContain("no write source");
    }
    expect((await getPage(storage, "team-b/doc"))!.markdown_body).toBe("secret plan");
    expect((await getPage(storage, "notes/shared"))!.markdown_body).toBe("draft");
  });

  it("refuses a read-only token", async () => {
    await putPage(storage, { slug: "team-a/doc", markdown_body: "draft", source_id: A });
    const r = await edit(
      { slug: "team-a/doc", expected_version: 1, edits: [{ old_text: "draft", new_text: "done" }] },
      { authInfo: auth(A, { scopes: ["read"] }) },
    );
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("insufficient_scope");
    expect((await getPage(storage, "team-a/doc"))!.markdown_body).toBe("draft");
  });
});

async function withFlagDisposition<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"];
  // `flag` stores the credential as written: a page from before the scan.
  process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"] = "flag";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"];
    else process.env["MEMRAIN_SECRET_SCAN_DISPOSITION"] = saved;
  }
}

describe("response redaction", () => {
  const GH = `gh${"p"}_${"z".repeat(36)}`;
  const leakyPage = (sourceId?: string) =>
    withFlagDisposition(() =>
      putPage(storage, {
        slug: "team-a/leaky",
        markdown_body: `token ${GH}\nStatus: draft\n`,
        ...(sourceId !== undefined ? { source_id: sourceId } : {}),
      }),
    );

  it("redacts a stored credential in the diff for a tenant", async () => {
    await leakyPage(A);
    const r = await edit(
      { slug: "team-a/leaky", expected_version: 1, edits: [{ old_text: "draft", new_text: "final" }] },
      { authInfo: auth(A) },
    );
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).not.toContain(GH);
    expect(payload(r).diff).toContain("[REDACTED:github-token:");
    expect(payload(r).version).toBe(2);
  });

  it("returns the diff raw to the operator", async () => {
    await leakyPage();
    const r = payload(await edit({ slug: "team-a/leaky", expected_version: 1, edits: [{ old_text: "draft", new_text: "final" }] }));
    expect(r.diff).toContain(`-token ${GH}`);
  });
});

describe("credentials inside a protected fence", () => {
  it("refuses an edit whose secret scan would rewrite a facts fence", async () => {
    const body = `Intro\n\n${FACTS.replace("Alice likes tea", `Alice's key is ${AWS}`)}\n\nOutro`;
    await withFlagDisposition(() => putPage(storage, { slug: "people/alice", markdown_body: body }));
    const r = await edit({ slug: "people/alice", expected_version: 1, edits: [{ old_text: "Outro", new_text: "Closing" }] });
    expect(r.isError).toBe(true);
    expect(payload(r).error).toBe("edit_protected_span");
    expect(payload(r).message).toContain("credential");
    expect(payload(r).suggestion).toContain("memrain secrets audit");
    expect((await getPage(storage, "people/alice"))!.markdown_body).toBe(body);
    expect(await version("people/alice")).toBe(1);
  });
});

describe("request_id replay", () => {
  it("replays page_edit's own response after the derived work failed", async () => {
    await putPage(storage, { slug: "notes/plan", markdown_body: "Status: draft\n" });
    const engine = storage.engine();
    const query = engine.query.bind(engine);
    let failed = false;
    // The derived work after the commit (link watermark) throws once.
    engine.query = (async (sql: string, params?: unknown[]) => {
      if (!failed && sql.includes("links_extracted_at = NOW()")) {
        failed = true;
        throw new Error("derived sync failed");
      }
      return query(sql, params);
    }) as typeof engine.query;
    const args = {
      slug: "notes/plan",
      expected_version: 1,
      edits: [{ old_text: "draft", new_text: "final" }],
      request_id: "edit-once",
    };
    let first: ToolCallResult;
    try {
      first = await edit(args);
    } finally {
      engine.query = query;
    }
    expect(failed).toBe(true);
    expect(first.isError).toBe(true);

    const retry = payload(await edit(args));
    expect(retry).toMatchObject({ ok: true, replayed: true, slug: "notes/plan", version: 2, changed: true, edits_applied: 1 });
    expect(retry.diff).toContain("+Status: final");
    expect(retry.version_n).toBeUndefined();
    expect(retry.content_hash).toBeUndefined();
    expect(retry.created).toBeUndefined();
    expect(await version("notes/plan")).toBe(2);
  });

  it("replays the same response after a clean first call", async () => {
    await putPage(storage, { slug: "notes/plan", markdown_body: "Status: draft\n" });
    const args = { slug: "notes/plan", expected_version: 1, edits: [{ old_text: "draft", new_text: "final" }], request_id: "edit-twice" };
    const first = payload(await edit(args));
    const retry = payload(await edit(args));
    expect(retry.replayed).toBe(true);
    expect(retry.version).toBe(first.version);
    expect(retry.diff).toBe(first.diff);
  });
});
