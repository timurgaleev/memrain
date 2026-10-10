/**
 * `quarantine_override`: a `quarantine clear` that survives the next write.
 *
 *  - Re-indexing the exact cleared title + body keeps the page released; an
 *    edit to the body expires the override and the gate hides it again.
 *  - `quarantine scan --apply` does not re-hide a cleared document.
 *  - An untrusted (remote) writer cannot plant the override, even one whose
 *    binding is correct for its content; a trusted local writer can.
 *  - The override never lifts the size gate.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQuarantine } from "../src/commands/quarantine.ts";
import { Storage } from "../src/core/storage.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { EMBED_SKIP_KEY } from "../src/core/embed-skip.ts";
import {
  GATE_OWNED_KEYS,
  QUARANTINE_OVERRIDE_KEY,
  hasCurrentQuarantineOverride,
  isQuarantined,
  quarantineOverrideBinding,
  withQuarantineOverride,
} from "../src/core/quarantine.ts";
import { assessContentSanity } from "../src/core/content-sanity.ts";
import { deterministicEmbed } from "./det-embed.ts";

const embedFn = (t: string) => Promise.resolve(deterministicEmbed(t));

const tmp = mkdtempSync(join(tmpdir(), "memrain-quarantine-override-"));
const cfgDir = join(tmp, ".memex");
const cfgPath = join(cfgDir, "config.json");
const dbPath = join(cfgDir, "brain.pglite");

const JUNK_TITLE = "Release notes";
const JUNK_BODY =
  "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d";
const JUNK = `# ${JUNK_TITLE}\n\n${JUNK_BODY}`;

async function withDb<T>(fn: (s: Storage) => Promise<T>): Promise<T> {
  const storage = new Storage({ dbPath });
  await storage.init();
  try {
    return await fn(storage);
  } finally {
    await storage.close();
  }
}

async function frontmatterOf(s: Storage, path: string): Promise<Record<string, unknown>> {
  const r = await s
    .engine()
    .query<{ frontmatter: Record<string, unknown> }>(
      "SELECT frontmatter FROM documents WHERE source_path = $1",
      [path],
    );
  return r.rows[0]!.frontmatter;
}

/** The binding the indexer computes for `path`, from its stored rows. */
async function storedBinding(s: Storage, path: string): Promise<string> {
  const d = await s
    .engine()
    .query<{ id: string; title: string }>("SELECT id, title FROM documents WHERE source_path = $1", [path]);
  const c = await s
    .engine()
    .query<{ content: string }>(
      "SELECT content FROM chunks WHERE document_id = $1 ORDER BY chunk_index",
      [d.rows[0]!.id],
    );
  return quarantineOverrideBinding(d.rows[0]!.title, c.rows.map((r) => r.content).join("\n\n"));
}

async function index(
  s: Storage,
  path: string,
  text: string,
  remote = false,
  extraFrontmatter?: Record<string, unknown>,
) {
  return indexDocument(
    s,
    { sourcePath: path, text, ...(extraFrontmatter ? { extraFrontmatter } : {}) },
    { embedFn, inferFrontmatter: false, remote },
  );
}

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = log;
  });
}

beforeAll(() => {
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({
      database: { type: "pglite", path: dbPath },
      embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
      storage: {},
    }),
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("quarantine override helpers", () => {
  it("strips remotely planted overrides along with every other gate marker", () => {
    expect(GATE_OWNED_KEYS).toContain(QUARANTINE_OVERRIDE_KEY);
    expect(GATE_OWNED_KEYS).toContain(EMBED_SKIP_KEY);
    expect(GATE_OWNED_KEYS).toContain("quarantine");
    expect(GATE_OWNED_KEYS).toContain("content_flag");
  });

  it("binds to title and body", () => {
    const b = quarantineOverrideBinding("T", "body");
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(quarantineOverrideBinding("T", "body")).toBe(b);
    expect(quarantineOverrideBinding("T2", "body")).not.toBe(b);
    expect(quarantineOverrideBinding("T", "body!")).not.toBe(b);
    const fm = { [QUARANTINE_OVERRIDE_KEY]: { binding: b, cleared_at: "2026-10-10T00:00:00Z" } };
    expect(hasCurrentQuarantineOverride({ title: "T", body: "body", frontmatter: fm })).toBe(true);
    expect(hasCurrentQuarantineOverride({ title: "T", body: "edited", frontmatter: fm })).toBe(false);
  });

  it("lifts the classifier verdict but never the size gate", () => {
    const body = `${JUNK_BODY}\n${"x".repeat(200)}`;
    const fm = {
      [QUARANTINE_OVERRIDE_KEY]: { binding: quarantineOverrideBinding("T", body), cleared_at: "now" },
    };
    const junk = assessContentSanity({ body, title: "T" });
    expect(junk.shouldQuarantine).toBe(true);
    const lifted = withQuarantineOverride(junk, { title: "T", body, frontmatter: fm });
    expect(lifted.shouldQuarantine).toBe(false);
    expect(lifted.shouldSkipEmbed).toBe(false);
    expect(lifted.reasons).not.toContain("junk_pattern");

    const oversized = assessContentSanity({ body, title: "T", bytes_block: 10, bytes_warn: 5 });
    expect(oversized.oversize).toBe(true);
    const kept = withQuarantineOverride(oversized, { title: "T", body, frontmatter: fm });
    expect(kept.shouldQuarantine).toBe(false);
    expect(kept.shouldSkipEmbed).toBe(true);
    expect(kept.flag_reason).toBe("oversized");
    expect(kept.reasons).toContain("oversize_block");
  });
});

describe("quarantine clear survives the next write", () => {
  it("re-indexing the cleared content keeps it released; an edit re-hides it", async () => {
    const first = await withDb((s) => index(s, "/notes/release.md", JUNK));
    expect(first.quarantined?.reason).toBe("junk_pattern");

    const code = await silenced(() =>
      runQuarantine({ sub: "clear", target: "/notes/release.md", force: true, json: true, configPath: cfgPath }),
    );
    expect(code).toBe(0);

    await withDb(async (s) => {
      const fm = await frontmatterOf(s, "/notes/release.md");
      expect(isQuarantined(fm)).toBe(false);
      expect(fm[QUARANTINE_OVERRIDE_KEY]).toBeDefined();

      // A remote re-write of the same content: the stored override carries.
      const again = await index(s, "/notes/release.md", JUNK, true);
      expect(again.quarantined).toBeUndefined();
      const after = await frontmatterOf(s, "/notes/release.md");
      expect(isQuarantined(after)).toBe(false);
      expect(after[QUARANTINE_OVERRIDE_KEY]).toEqual(fm[QUARANTINE_OVERRIDE_KEY]);

      const edited = await index(s, "/notes/release.md", `${JUNK}\n\nOne more line.`);
      expect(edited.quarantined?.reason).toBe("junk_pattern");
      expect(isQuarantined(await frontmatterOf(s, "/notes/release.md"))).toBe(true);
    });
  });

  it("scan --apply does not re-hide a cleared document", async () => {
    await withDb((s) => index(s, "/notes/scan.md", JUNK));
    await silenced(() =>
      runQuarantine({ sub: "clear", target: "/notes/scan.md", force: true, json: true, configPath: cfgPath }),
    );
    await silenced(() => runQuarantine({ sub: "scan", apply: true, json: true, configPath: cfgPath }));
    await withDb(async (s) => {
      expect(isQuarantined(await frontmatterOf(s, "/notes/scan.md"))).toBe(false);
    });
  });
});

describe("override trust boundary", () => {
  it("a remote writer cannot plant a correctly bound override; a trusted one can", async () => {
    await withDb(async (s) => {
      await index(s, "/planted.md", JUNK);
      // The binding is public knowledge (a hash of the content), so the strip
      // is the only thing standing between a writer and an unhidden page.
      const binding = await storedBinding(s, "/planted.md");
      const planted = {
        [QUARANTINE_OVERRIDE_KEY]: { binding, cleared_at: "2026-10-10T00:00:00Z" },
      };

      const remote = await index(s, "/planted.md", JUNK, true, planted);
      expect(remote.quarantined?.reason).toBe("junk_pattern");
      const remoteFm = await frontmatterOf(s, "/planted.md");
      expect(isQuarantined(remoteFm)).toBe(true);
      expect(remoteFm[QUARANTINE_OVERRIDE_KEY]).toBeUndefined();

      const local = await index(s, "/planted.md", JUNK, false, planted);
      expect(local.quarantined).toBeUndefined();
      expect(isQuarantined(await frontmatterOf(s, "/planted.md"))).toBe(false);
    });
  });
});
