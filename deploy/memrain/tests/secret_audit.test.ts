/**
 * `memrain secrets audit`: stored text is scanned again with the current
 * rules. A dry run reports hits by store, row, field, kind, fingerprint and
 * line and changes nothing; `--apply --yes` rewrites them. No output, audit
 * row or log line ever carries a matched value.
 *
 * Legacy rows are seeded under the `flag` disposition (stored as written) or
 * by plain SQL, the way text stored before the guards looks. Fixture
 * credentials are assembled at run time so no literal credential shape sits in
 * the repository.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { putPage } from "../src/core/pages.ts";
import { auditStoredSecrets, latestSecretAuditRun } from "../src/core/secret-audit.ts";
import { SECRET_SCAN_VERSION, fingerprintSecret } from "../src/core/secret-scan.ts";
import { runSecretsAudit } from "../src/commands/secrets.ts";
import { deterministicEmbed } from "./det-embed.ts";

const TOKEN = ["gh", "p_"].join("") + "A1b2C3d4".repeat(4) + "Zz9Y";
const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
const VALUES = [TOKEN, AWS];

let tmp: string;
let storage: Storage;
const savedDisposition = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
const mirror = { embedFn: async (t: string) => deterministicEmbed(t) };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-secret-audit-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});

afterEach(async () => {
  if (savedDisposition === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = savedDisposition;
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function seedLegacy(): Promise<void> {
  const engine = storage.engine();
  process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
  await putPage(storage, {
    slug: "notes/leak",
    type: "note",
    title: "Deploy notes",
    markdown_body: `# Deploy\n\nthe token is ${TOKEN}\nend`,
    compiled_truth: { creds: { aws: AWS } },
  });
  await putPage(storage, { slug: "notes/clean", type: "note", markdown_body: "nothing to see" });
  delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  await engine.query(`INSERT INTO entity_facts (entity_slug, fact) VALUES ('people/a', $1)`, [`uses ${TOKEN}`]);
  await engine.query(`INSERT INTO raw_data (slug, source, data) VALUES ('people/a', 'test', $1::text::jsonb)`, [
    JSON.stringify({ nested: [{ key: AWS }] }),
  ]);
  await engine.query(
    `INSERT INTO synth_takes (take_key, source_ref, source_hash, prompt_version, claim_text, kind, weight, status, model_id)
     VALUES ('tk-1', 'd1', 'h', 'v1', $1, 'fact', 0.5, 'queued', 'm')`,
    [`claim ${TOKEN}`],
  );
  await engine.query(`INSERT INTO documents (id, source_path, title, frontmatter) VALUES ('doc_code', 'src/a.ts', 'a.ts', '{"kind":"code"}')`);
  await engine.query(`INSERT INTO chunks (id, document_id, chunk_index, content) VALUES ('doc_code_c0', 'doc_code', 0, $1)`, [
    `const k = "${TOKEN}";`,
  ]);
}

async function scalar(sql: string, params: unknown[] = []): Promise<unknown> {
  const r = await storage.engine().query<{ v: unknown }>(sql, params);
  return r.rows[0]?.v;
}

describe("auditStoredSecrets dry run", () => {
  it("reports hits by store, field, kind, fingerprint and line, and changes nothing", async () => {
    await seedLegacy();
    const r = await auditStoredSecrets(storage);
    expect(r.applied).toBe(false);
    expect(r.scan_version).toBe(SECRET_SCAN_VERSION);
    expect(r.by_kind).toEqual({
      pages: 2,
      page_versions: 2,
      entity_facts: 1,
      synth_takes: 1,
      chunks: 1,
      raw_data: 1,
    });
    expect(r.hits_total).toBe(8);
    expect(r.rows_affected).toBe(6);
    expect(r.code_chunks_affected).toBe(1);
    expect(r.by_secret_kind).toEqual({ "github-token": 5, "aws-access-key": 3 });

    const body = r.hits.find((h) => h.kind === "pages" && h.field === "markdown_body");
    expect(body).toEqual({
      kind: "pages",
      ref: "notes/leak",
      field: "markdown_body",
      secret_kind: "github-token",
      fingerprint: fingerprintSecret(TOKEN),
      line: 3,
    });
    expect(r.hits.find((h) => h.kind === "page_versions")?.ref).toBe("notes/leak@v1");
    expect(r.hits.find((h) => h.field === "compiled_truth")?.line).toBeNull();

    const json = JSON.stringify(r);
    for (const v of VALUES) expect(json).not.toContain(v);

    expect(String(await scalar(`SELECT markdown_body AS v FROM pages WHERE slug = 'notes/leak'`))).toContain(TOKEN);
    expect(String(await scalar(`SELECT fact AS v FROM entity_facts`))).toContain(TOKEN);

    const run = await latestSecretAuditRun(storage.engine());
    expect(run?.applied).toBe(false);
    expect(run?.hits_total).toBe(8);
    expect(run?.code_chunks_affected).toBe(1);
    const stored = JSON.stringify(await storage.engine().query(`SELECT * FROM secret_audit_runs`));
    for (const v of VALUES) expect(stored).not.toContain(v);
  });

  it("catches a bare echo in a field scanned before the field that claimed the value", async () => {
    const bearer = "q7Xz" + "Lm3Pw9Rt".repeat(3);
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
    await putPage(storage, { slug: "notes/echo", type: "note", title: `deploy ${bearer}`, markdown_body: `Authorization: Bearer ${bearer}` });
    delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    const r = await auditStoredSecrets(storage, { kinds: ["pages"] });
    const fields = r.hits.map((h) => `${h.field}:${h.secret_kind}`).sort();
    expect(fields).toEqual(["markdown_body:bearer-token", "title:bearer-token-echo"]);
    expect(JSON.stringify(r)).not.toContain(bearer);
  });

  it("caps the listed hits but keeps the counts whole", async () => {
    await seedLegacy();
    const r = await auditStoredSecrets(storage, { limit: 2 });
    expect(r.hits.length).toBe(2);
    expect(r.hits_truncated).toBe(true);
    expect(r.hits_total).toBe(8);
  });

  it("under --source scans only stores with a source column", async () => {
    await seedLegacy();
    const r = await auditStoredSecrets(storage, { sourceId: "default", kinds: ["pages", "synth_takes", "raw_data"] });
    expect(r.kinds).toEqual(["pages"]);
    expect(r.skipped_kinds).toEqual(["synth_takes", "raw_data"]);
    expect(r.by_kind).toEqual({ pages: 2 });
    // A source-filtered run does not speak for the whole brain.
    expect(await latestSecretAuditRun(storage.engine())).toBeNull();
  });
});

describe("auditStoredSecrets apply", () => {
  it("rewrites every hit, keeps history honest, and a second run finds nothing", async () => {
    await seedLegacy();
    const r = await auditStoredSecrets(storage, { apply: true, mirror });
    expect(r.errors).toEqual([]);
    expect(r.rows_rewritten).toBe(6);

    const page = await storage.engine().query<{ markdown_body: string; compiled_truth: unknown }>(
      `SELECT markdown_body, compiled_truth FROM pages WHERE slug = 'notes/leak'`,
    );
    expect(page.rows[0]!.markdown_body).toContain(`[REDACTED:github-token:${fingerprintSecret(TOKEN)}]`);
    expect(JSON.stringify(page.rows[0]!.compiled_truth)).not.toContain(AWS);
    expect(await scalar(`SELECT written_by AS v FROM page_versions WHERE slug = 'notes/leak' ORDER BY version_n DESC LIMIT 1`)).toBe("secrets-audit");
    const v1 = await storage.engine().query<{ body_snapshot: string; scrubbed_at: string | null }>(
      `SELECT body_snapshot, scrubbed_at::text AS scrubbed_at FROM page_versions WHERE slug = 'notes/leak' AND version_n = 1`,
    );
    expect(v1.rows[0]!.body_snapshot).not.toContain(TOKEN);
    expect(v1.rows[0]!.scrubbed_at).not.toBeNull();

    for (const sql of [
      `SELECT fact AS v FROM entity_facts`,
      `SELECT data::text AS v FROM raw_data`,
      `SELECT claim_text AS v FROM synth_takes`,
      `SELECT string_agg(content, ' ') AS v FROM chunks`,
    ]) {
      const v = String(await scalar(sql));
      for (const secret of VALUES) expect(v).not.toContain(secret);
    }

    const log = JSON.stringify(
      (await storage.engine().query(`SELECT source_ref, summary FROM ingest_log WHERE source_type = 'secret-audit-redacted'`)).rows,
    );
    expect(log).toContain("entity_facts:");
    for (const secret of VALUES) expect(log).not.toContain(secret);

    const again = await auditStoredSecrets(storage);
    expect(again.hits_total).toBe(0);
  });

  it("leaves a row an edit changed since the scan", async () => {
    await seedLegacy();
    // A concurrent writer: the stored fact moves on between scan and rewrite.
    const engine = storage.engine();
    const realQuery = engine.query.bind(engine);
    const spy = spyOn(engine, "query").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("UPDATE entity_facts")) await realQuery(`UPDATE entity_facts SET fact = 'rewritten by someone else'`);
      return realQuery(sql, params);
    }) as typeof engine.query);
    try {
      const r2 = await auditStoredSecrets(storage, { kinds: ["entity_facts"], apply: true });
      expect(r2.rows_rewritten).toBe(0);
      expect(r2.errors.length).toBe(1);
      expect(r2.errors[0]).toContain("changed since it was scanned");
    } finally {
      spy.mockRestore();
    }
    expect(await scalar(`SELECT fact AS v FROM entity_facts`)).toBe("rewritten by someone else");
  });
});

describe("memrain secrets audit", () => {
  it("refuses --apply without --yes and changes nothing", async () => {
    await seedLegacy();
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSecretsAudit({ apply: true, storage })).toBe(2);
    } finally {
      err.mockRestore();
    }
    expect(String(await scalar(`SELECT fact AS v FROM entity_facts`))).toContain(TOKEN);
    expect(await scalar(`SELECT count(*)::int AS v FROM secret_audit_runs`)).toBe(0);
  });

  it("rejects an unknown kind", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSecretsAudit({ kinds: ["pagez"], storage })).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("prints JSON and human output without any value, and exits 1 while hits remain", async () => {
    await seedLegacy();
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      expect(await runSecretsAudit({ json: true, storage })).toBe(1);
      expect(await runSecretsAudit({ storage })).toBe(1);
    } finally {
      log.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain('"hits_total": 8');
    expect(out).toContain("notes/leak markdown_body:3 github-token:");
    for (const v of VALUES) expect(out).not.toContain(v);
  });
});
