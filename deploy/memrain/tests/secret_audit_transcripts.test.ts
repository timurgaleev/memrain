/**
 * The transcript audit: stored agent transcripts (and pages under the slug
 * prefixes an operator names) rescanned with the transcript lane's rules.
 * Connector mail, calendar and meeting pages are never scanned or changed.
 * A dry run reports counts by kind and page slugs only; an apply keeps every
 * original in the secret store before the new version replaces the text, and
 * refuses without the key that would keep them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { getPage, putPage } from "../src/core/pages.ts";
import { revealSecret } from "../src/core/secret-store.ts";
import { auditStoredSecrets } from "../src/core/secret-audit.ts";
import { runSecretsAudit } from "../src/commands/secrets.ts";
import { deterministicEmbed } from "./det-embed.ts";

const SID = ["SYNTH", "cookieA0001fake"].join("");
const PW = ["Synth", "NetrcMulti4321"].join("");
const MARKER = /\[REDACTED:([a-z0-9-]+):([0-9a-f]{16})\]/g;
const TRANSCRIPT = "transcripts/claude-code/sess-1-p1";
const mirror = { embedFn: async (t: string) => deterministicEmbed(t) };

let tmp: string;
let storage: Storage;
const saved: Record<string, string | undefined> = {};
const ENV = ["MEMRAIN_CONNECTOR_KEK", "MEMRAIN_CONNECTOR_KEK_FILE", "MEMRAIN_SECRET_SCAN_DISPOSITION"] as const;

beforeEach(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.MEMRAIN_CONNECTOR_KEK_FILE;
  delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
  process.env.MEMRAIN_CONNECTOR_KEK = randomBytes(32).toString("base64");
  tmp = mkdtempSync(join(tmpdir(), "memrain-audit-transcripts-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const body = `intro\ncurl -H 'Cookie: sid=${SID}' https://app.acme-example.test/\nmachine api.acme-example.test login alice password ${PW}\n`;
  await putPage(storage, { slug: TRANSCRIPT, type: "conversation", allowAdHocType: true, markdown_body: body, written_by: "transcripts-ingest", outsideText: true });
  await putPage(storage, { slug: "mail/thread-1", type: "connector-mail", allowAdHocType: true, markdown_body: body, sealSecrets: false });
  await putPage(storage, { slug: "notes/howto", markdown_body: body });
  await putPage(storage, { slug: "agents/run-1", markdown_body: `Cookie: sid=${SID}\n` });
});
afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function body(slug: string): Promise<string> {
  return (await getPage(storage, slug))!.markdown_body;
}

describe("transcript audit, dry run", () => {
  it("counts by kind and lists transcript slugs only, never a value or fingerprint", async () => {
    const r = await auditStoredSecrets(storage, { lane: "transcripts" });
    expect(r.applied).toBe(false);
    expect(r.kinds).toEqual(["pages"]);
    expect(r.by_secret_kind).toEqual({ "cookie-header": 1, "netrc-password": 1 });
    expect(r.slugs).toEqual([TRANSCRIPT]);
    expect(r.hits).toEqual([]);
    const text = JSON.stringify(r);
    for (const v of [SID, PW]) expect(text).not.toContain(v);
    expect(text).not.toMatch(/[0-9a-f]{16}/);
    expect(await body(TRANSCRIPT)).toContain(SID);
  });

  it("takes extra slug prefixes, and never a connector page even under one", async () => {
    const r = await auditStoredSecrets(storage, { lane: "transcripts", slugPrefixes: ["transcripts/", "agents/", "mail/"] });
    expect(r.slugs).toEqual(["agents/run-1", TRANSCRIPT]);
  });

  it("records a run that skips the default prefix as partial", async () => {
    await auditStoredSecrets(storage, { lane: "transcripts", slugPrefixes: ["agents/"] });
    const last = await storage.engine().query<{ lane: string }>(`SELECT lane FROM secret_audit_runs ORDER BY id DESC LIMIT 1`);
    expect(last.rows[0]!.lane).toBe("transcripts:partial");
  });
});

describe("transcript audit, apply", () => {
  it("keeps every original before rewriting, as a new version; connector and other pages untouched", async () => {
    const mailBefore = await body("mail/thread-1");
    const notesBefore = await body("notes/howto");
    const r = await auditStoredSecrets(storage, { lane: "transcripts", apply: true, mirror });
    expect(r.rows_rewritten).toBe(1);
    expect(r.errors).toEqual([]);
    const after = await body(TRANSCRIPT);
    for (const v of [SID, PW]) expect(after).not.toContain(v);
    const markers = [...after.matchAll(MARKER)];
    expect(markers.map((m) => m[1]).sort()).toEqual(["cookie-header", "netrc-password"]);
    const values = await Promise.all(markers.map(async (m) => (await revealSecret(storage.engine(), { slug: TRANSCRIPT, fingerprint: m[2]! }, "test")).value));
    expect(values.sort()).toEqual([PW, SID].sort());
    const v = await storage.engine().query<{ written_by: string }>(`SELECT written_by FROM page_versions WHERE slug = $1 ORDER BY version_n DESC LIMIT 1`, [TRANSCRIPT]);
    expect(v.rows[0]!.written_by).toBe("secrets-audit");
    expect((await getPage(storage, TRANSCRIPT))!.compiled_truth).toMatchObject({ outside_neutralized: 1 });
    expect(await body("mail/thread-1")).toBe(mailBefore);
    expect(await body("notes/howto")).toBe(notesBefore);

    const again = await auditStoredSecrets(storage, { lane: "transcripts" });
    expect(again.hits_total).toBe(0);
  });

  it("refuses a neutralized page whose carried fence would bring a redacted value back", async () => {
    const slug = "transcripts/claude-code/fenced-p1";
    // A legacy inline fence: the carry keeps its span, which the redacted body no longer holds verbatim.
    const fenced = `intro\nCookie: sid=${SID}\nsee <!--- memrain:facts:begin --> Cookie: sid=${SID} <!--- memrain:facts:end --> here\n`;
    await putPage(storage, { slug, type: "conversation", allowAdHocType: true, markdown_body: fenced, outsideText: true });
    const before = await body(slug);
    const r = await auditStoredSecrets(storage, { lane: "transcripts", apply: true, mirror });
    expect(r.errors.some((e) => e.includes(slug) && e.includes("not rewritten"))).toBe(true);
    expect(await body(slug)).toBe(before);
  });

  it("never lists a slug that holds a value the body redacted", async () => {
    const value = "abcdefgh123456zz";
    await putPage(storage, { slug: `transcripts/test/${value}-p1`, type: "conversation", allowAdHocType: true, markdown_body: `Cookie: sid=${value}\n` });
    const r = await auditStoredSecrets(storage, { lane: "transcripts" });
    expect(JSON.stringify(r)).not.toContain(value);
  });

  it("never lists a slug holding a value past the echo dictionary's cap", async () => {
    const jar = Array.from({ length: 40 }, (_, i) => `c${i}=${["SYNTH", "jarvalue", String(i).padStart(4, "0")].join("")}`).join("; ");
    const last = ["SYNTH", "jarvalue", "0039"].join("");
    await putPage(storage, { slug: `transcripts/test/${last.toLowerCase()}-p1`, type: "conversation", allowAdHocType: true, markdown_body: `Cookie: ${jar.toLowerCase()}\n` });
    const r = await auditStoredSecrets(storage, { lane: "transcripts" });
    expect(JSON.stringify(r)).not.toContain(last.toLowerCase());
  });

  it("refuses without the connector key and changes nothing", async () => {
    delete process.env.MEMRAIN_CONNECTOR_KEK;
    const before = await body(TRANSCRIPT);
    await expect(auditStoredSecrets(storage, { lane: "transcripts", apply: true, mirror })).rejects.toThrow(/connector key/);
    expect(await body(TRANSCRIPT)).toBe(before);
  });

  it("the CLI runs the lane with --transcripts", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
    try {
      expect(await runSecretsAudit({ storage, transcripts: true })).toBe(1);
    } finally {
      console.log = orig;
    }
    const out = lines.join("\n");
    expect(out).toContain("cookie-header: 1");
    expect(out).toContain(TRANSCRIPT);
    expect(out).not.toContain(SID);
  });
});
