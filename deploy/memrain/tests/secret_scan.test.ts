/**
 * Credentials never reach a stored page, a version, a chunk or an embedding.
 *
 * The fixture secrets are assembled at run time so no literal credential shape
 * sits in the repository for a scanner to trip on.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { appendPage, getPage, putPage } from "../src/core/pages.ts";
import { indexDocument } from "../src/core/indexer.ts";
import { fingerprintSecret, guardSecretsDeep, scanSecrets, type SecretFinding } from "../src/core/secret-scan.ts";
import { deterministicEmbed } from "./det-embed.ts";

const AWS = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
const PAT = `memex_${"ab12".repeat(16)}`;
const GH = `gh${"p"}_${"x".repeat(36)}`;
const PEM = [`-----BEGIN ${"RSA "}PRIVATE KEY-----`, "MIIEpAIBAAKCAQEAtest", "abcdefg", "-----END RSA PRIVATE KEY-----"].join("\n");

let tmp: string;
let storage: Storage;
const saved = { d: process.env.MEMRAIN_SECRET_SCAN_DISPOSITION, a: process.env.MEMRAIN_SECRET_SCAN_ALLOW };
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-secret-scan-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  for (const [k, v] of [["MEMRAIN_SECRET_SCAN_DISPOSITION", saved.d], ["MEMRAIN_SECRET_SCAN_ALLOW", saved.a]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("scanSecrets", () => {
  it("replaces named credentials and PEM keys with a kind and a fingerprint", () => {
    const r = scanSecrets(`aws ${AWS}\npat ${PAT}\n${PEM}\ntail ${GH}`);
    expect(r.findings.map((f) => f.kind)).toEqual(["private-key", "aws-access-key", "github-token", "memex-pat"]);
    for (const secret of [AWS, PAT, GH, "MIIEpAIBAAKCAQEAtest"]) expect(r.text).not.toContain(secret);
    expect(r.text).toContain(`[REDACTED:aws-access-key:${fingerprintSecret(AWS)}]`);
    expect(r.text.startsWith("aws ")).toBe(true);
    expect(r.text.endsWith(`tail [REDACTED:github-token:${fingerprintSecret(GH)}]`)).toBe(true);
  });

  it("stops an unclosed key block at the end of its base64, not the end of the note", () => {
    const note = `How to spot a key: it starts with\n-----BEGIN ${"RSA "}PRIVATE KEY-----\nand the rest of this note must survive.`;
    const r = scanSecrets(note);
    expect(r.text).toContain("and the rest of this note must survive.");
    const truncated = `-----BEGIN ${"OPENSSH "}PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQQQQQQQQ\nafter the key`;
    expect(scanSecrets(truncated).text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(scanSecrets(truncated).text).toContain("after the key");
  });

  it("catches an AWS secret key and other vendor tokens, and leaves IAM ids alone", () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const text = `aws_secret_access_key = ${secret}\nrole ${["AR", "OA"].join("")}ABCDEFGHIJKLMNOP\n${"gl"}pat-${"a".repeat(20)}`;
    const r = scanSecrets(text);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain(`${["AR", "OA"].join("")}ABCDEFGHIJKLMNOP`);
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["aws-secret-key", "gitlab-token"]);
  });

  it("leaves ids, hashes and client ids alone", () => {
    const text = `client memex_cl_${"f".repeat(64)} enrollment memex_enr_${"0".repeat(32)} sha ${"a".repeat(64)} uuid 123e4567-e89b-12d3-a456-4266141740ab`;
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });

  it("catches memex client secrets and authorization codes", () => {
    const cs = `memex_${"cs"}_${"9f".repeat(32)}`;
    const code = `memex_${"code"}_${"4e".repeat(32)}`;
    const r = scanSecrets(`secret ${cs}\ncode ${code}`);
    expect(r.findings.map((f) => f.kind)).toEqual(["memex-token", "memex-token"]);
    expect(r.text).toBe(`secret [REDACTED:memex-token:${fingerprintSecret(cs)}]\ncode [REDACTED:memex-token:${fingerprintSecret(code)}]`);
  });

  it("catches a JWT, a bearer token and a database URL with a password", () => {
    const jwt = [`ey${"J"}hbGciOiJIUzI1NiJ9`, "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
    const opaque = `tok_${"Zq8".repeat(10)}`;
    const dbUrl = `${"postgres"}ql://app:${"s3cr3t".repeat(3)}@db.internal:5432/app`;
    const text = `Authorization: Bearer ${opaque}\nAuthorization: Bearer ${jwt}\nDATABASE_URL=${dbUrl}`;
    const r = scanSecrets(text);
    expect(r.findings.map((f) => f.kind)).toEqual(["jwt", "database-url", "bearer-token"]);
    for (const secret of [opaque, jwt, "s3cr3t"]) expect(r.text).not.toContain(secret);
    expect(r.text).toContain(`Authorization: Bearer [REDACTED:bearer-token:${fingerprintSecret(opaque)}]`);
    expect(r.text).toContain(`Authorization: Bearer [REDACTED:jwt:${fingerprintSecret(jwt)}]`);
    for (const header of [
      `curl -H "authorization: bearer ${opaque}"`,
      `{"Authorization": "Bearer ${opaque}"}`,
      `AUTHORIZATION=Bearer ${opaque}`,
    ]) {
      expect(scanSecrets(header).findings.map((f) => f.kind)).toEqual(["bearer-token"]);
    }
    expect(r.text).toContain("db.internal:5432/app");
  });

  it("redacts a database password that holds a raw @ in full", () => {
    const r = scanSecrets(`${"postgres"}://app:p@ss@db.internal:5432/app`);
    expect(r.findings.map((f) => f.kind)).toEqual(["database-url"]);
    expect(r.text).not.toContain("ss@db");
    expect(r.text).toContain("db.internal:5432/app");
  });

  it("redacts a bearer token past 4096 characters to its end", () => {
    const long = "Zq8".repeat(2000);
    const r = scanSecrets(`Authorization: Bearer ${long} next`);
    expect(r.findings.map((f) => f.kind)).toEqual(["bearer-token"]);
    expect(r.text).toBe(`Authorization: Bearer [REDACTED:bearer-token:${fingerprintSecret(long)}] next`);
  });

  it("catches a JWT whose claims segment is an empty object", () => {
    const jwt = [`ey${"J"}hbGciOiJIUzI1NiJ9`, "e30", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"].join(".");
    const r = scanSecrets(`token ${jwt}`);
    expect(r.findings.map((f) => f.kind)).toEqual(["jwt"]);
    expect(r.text).toBe(`token [REDACTED:jwt:${fingerprintSecret(jwt)}]`);
  });

  it("catches a bearer token stored as the value of an Authorization key", () => {
    const opaque = `tok_${"Zq8".repeat(10)}`;
    const findings: SecretFinding[] = [];
    const out = guardSecretsDeep(
      { headers: { Authorization: `Bearer ${opaque}`, "proxy-authorization": `bearer ${opaque}`, Accept: `Bearer ${opaque}` } },
      "test",
      findings,
    );
    const fp = fingerprintSecret(opaque);
    expect(out).toEqual({
      headers: {
        Authorization: `Bearer [REDACTED:bearer-token:${fp}]`,
        "proxy-authorization": `bearer [REDACTED:bearer-token:${fp}]`,
        // Not a header the bearer rule anchors on, but the same value claimed
        // next to it: the echo pass scrubs it.
        Accept: `Bearer [REDACTED:bearer-token-echo:${fp}]`,
      },
    });
    expect(findings.map((f) => f.kind)).toEqual(["bearer-token", "bearer-token", "bearer-token-echo"]);
  });

  it("leaves bearer prose, password-less URLs and JWT-like fragments alone", () => {
    const text = [
      "Send a Bearer token in the header.",
      "Bearer authentication/authorization is documented below.",
      "the bearer instrument-of-record-transfer applies",
      "bearer /var/lib/memex/something/long.txt",
      "Authorization: Bearer ${TOKEN}",
      "postgres://db.internal:5432/app and mysql://user@host/db",
      "eyJhbGciOiJIUzI1NiJ9 alone is only a header",
    ].join("\n");
    expect(scanSecrets(text)).toEqual({ text, findings: [] });
  });

  it("scans a 1 MB line of near-miss prefixes in well under 200 ms", () => {
    const unit = "eyJaaaaaaaa-Bearer\tpostgres://u:pmemex_cs_xmongodb+srv://";
    const line = unit.repeat(Math.ceil(1_048_576 / unit.length)).slice(0, 1_048_576);
    for (const s of [line, "eyJ-".repeat(262_144), `Authorization: Bearer ${"a".repeat(1_048_550)}`, "Authorization: Bearer ".repeat(47_663), `postgres://${":".repeat(1_048_565)}`]) {
      const t = performance.now();
      scanSecrets(s);
      expect(performance.now() - t).toBeLessThan(200);
    }
  });

  it("stays linear on adversarial text", () => {
    const time = (n: number) => {
      const s = `${"AKIA".repeat(n)}${"-----BEGIN ".repeat(n / 4)}${"memex_at_".repeat(n / 4)}${"x".repeat(n)}`;
      const t = performance.now();
      scanSecrets(s);
      return performance.now() - t;
    };
    time(2000);
    const small = Math.max(time(20_000), 0.5);
    expect(time(80_000) / small).toBeLessThan(10);
  });
});

describe("a page write", () => {
  it("stores the page, its version and its chunks without the credentials, and audits them", async () => {
    const r = await putPage(storage, { slug: "notes/env", markdown_body: `## Env\n\nkey ${AWS}\n\n${PEM}\n\npat ${PAT}` });
    expect(r.secrets_found).toBe(3);
    const page = await getPage(storage, "notes/env");
    for (const secret of [AWS, PAT, "MIIEpAIBAAKCAQEAtest"]) expect(page!.markdown_body).not.toContain(secret);
    const versions = await storage.engine().query<{ body_snapshot: string }>(
      `SELECT body_snapshot FROM page_versions WHERE slug = 'notes/env'`,
    );
    expect(versions.rows.length).toBeGreaterThan(0);
    for (const v of versions.rows) expect(v.body_snapshot).not.toContain(AWS);
    const audit = await storage.engine().query<{ source_type: string; summary: string; source_ref: string }>(
      `SELECT source_type, summary, source_ref FROM ingest_log WHERE source_type LIKE 'secret-%'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.source_ref).toBe("notes/env");
    expect(audit.rows[0]!.summary).toContain(`aws-access-key:${fingerprintSecret(AWS)}`);
    expect(audit.rows[0]!.summary).not.toContain(AWS);
  });

  it("redacts a bare echo in the body of a token claimed in the title", async () => {
    const opaque = `tok_${"Qx7".repeat(10)}`;
    await putPage(storage, { slug: "notes/echo", title: `Authorization: Bearer ${opaque}`, markdown_body: `the reply was ${opaque}` });
    const page = await getPage(storage, "notes/echo");
    expect(page!.markdown_body).toBe(`the reply was [REDACTED:bearer-token-echo:${fingerprintSecret(opaque)}]`);
    expect(page!.title).not.toContain(opaque);
  });

  it("redacts an append too", async () => {
    await putPage(storage, { slug: "notes/log", markdown_body: "start" });
    await appendPage(storage, { slug: "notes/log", content: `leaked ${GH}` });
    expect((await getPage(storage, "notes/log"))!.markdown_body).not.toContain(GH);
  });

  it("refuses the write when the disposition is reject", async () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    await expect(putPage(storage, { slug: "notes/refused", markdown_body: `key ${AWS}` })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(await getPage(storage, "notes/refused")).toBeNull();
  });

  it("audits a flagged credential once, not on every identical re-put", async () => {
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "flag";
    const flagged = async () =>
      Number((await storage.engine().query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ingest_log WHERE source_type = 'secret-flagged' AND source_ref = 'notes/flagged'`,
      )).rows[0]!.n);
    const first = await putPage(storage, { slug: "notes/flagged", markdown_body: `key ${AWS}` });
    expect(first.secrets_found).toBe(1);
    expect(await flagged()).toBe(1);
    const again = await putPage(storage, { slug: "notes/flagged", markdown_body: `key ${AWS}` });
    expect(again).toMatchObject({ changed: false, secrets_found: 1 });
    expect(await flagged()).toBe(1);
  });

  it("keeps an allowed fingerprint", async () => {
    process.env.MEMRAIN_SECRET_SCAN_ALLOW = fingerprintSecret(AWS);
    await putPage(storage, { slug: "notes/allowed", markdown_body: `example ${AWS}` });
    expect((await getPage(storage, "notes/allowed"))!.markdown_body).toContain(AWS);
  });
});

describe("indexing a file", () => {
  it("chunks and embeds the redacted text", async () => {
    await indexDocument(
      storage,
      { sourcePath: "/vault/env.md", text: `# Env\n\nThe deploy key is ${AWS} and nothing else of note is here.` },
      { embedFn: async (t: string) => deterministicEmbed(t) },
    );
    const chunks = await storage.engine().query<{ content: string }>(`SELECT content FROM chunks`);
    expect(chunks.rows.length).toBeGreaterThan(0);
    for (const c of chunks.rows) expect(c.content).not.toContain(AWS);
  });
});

describe("looksBinary", () => {
  it("passes text in any script and stops binary formats", async () => {
    const { looksBinary } = await import("../src/core/binary-guard.ts");
    expect(looksBinary(Buffer.from("Заметка о деплое 🚀 — ok\n"))).toBe(false);
    expect(looksBinary(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true);
    expect(looksBinary(Buffer.from([0x68, 0x69, 0x00]))).toBe(true);
  });
});


describe("the other writes", () => {
  const auditRows = async (type: string) =>
    (await storage.engine().query<{ source_ref: string; summary: string }>(
      `SELECT source_ref, summary FROM ingest_log WHERE source_type = $1`,
      [type],
    )).rows;

  it("redacts a page title and every string in compiled_truth, keys included", async () => {
    await putPage(storage, {
      slug: "notes/truth",
      title: `deploy ${GH}`,
      markdown_body: "clean",
      compiled_truth: { env: { key: AWS }, list: [PEM], [PAT]: "k" },
    });
    const stored = await storage.engine().query<{ title: string; truth: string }>(
      `SELECT title, compiled_truth::text AS truth FROM pages WHERE slug = 'notes/truth'`,
    );
    const row = stored.rows[0]!;
    for (const secret of [GH, AWS, PAT, "MIIEpAIBAAKCAQEAtest"]) expect(row.title + row.truth).not.toContain(secret);
    const snaps = await storage.engine().query<{ t: string }>(
      `SELECT compiled_truth_snapshot::text AS t FROM page_versions WHERE slug = 'notes/truth'`,
    );
    for (const s of snaps.rows) expect(s.t).not.toContain(AWS);
    const audit = await auditRows("secret-redacted");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary.split(", ")).toHaveLength(4);
  });

  it("redacts a bearer token held under an Authorization key in compiled_truth", async () => {
    const opaque = `tok_${"Zq8".repeat(10)}`;
    const r = await putPage(storage, {
      slug: "notes/headers",
      markdown_body: "clean",
      compiled_truth: { Authorization: `Bearer ${opaque}` },
    });
    expect(r.secrets_found).toBe(1);
    const stored = await storage.engine().query<{ truth: string }>(
      `SELECT compiled_truth::text AS truth FROM pages WHERE slug = 'notes/headers'`,
    );
    expect(stored.rows[0]!.truth).not.toContain(opaque);
    expect(stored.rows[0]!.truth).toContain(`Bearer [REDACTED:bearer-token:${fingerprintSecret(opaque)}]`);
  });






});
