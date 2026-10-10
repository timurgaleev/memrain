/**
 * redactToolResult: credentials in a retrieval result are replaced on the way
 * out, identity fields never change, one echo dictionary spans the response,
 * and the work stays bounded on a huge payload.
 *
 * Fixture secrets are assembled at run time so no literal credential shape
 * sits in the repository.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  MAX_FIELDS,
  MAX_RESPONSE_CHARS,
  OUTPUT_LIMIT_MARKER,
  outputRedactionEnabled,
  redactToolResult,
} from "../src/core/output-redaction.ts";
import { fingerprintSecret } from "../src/core/secret-scan.ts";

const GH = `gh${"p"}_${"x".repeat(36)}`;
const OPAQUE = `tok_${"Qx7".repeat(10)}`;
const NONE = new Set<string>();

const result = (payload: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] });
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

const savedEnv = process.env.MEMRAIN_OUTPUT_REDACTION;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEMRAIN_OUTPUT_REDACTION;
  else process.env.MEMRAIN_OUTPUT_REDACTION = savedEnv;
});

describe("redactToolResult", () => {
  it("redacts a credential in a nested string and counts it", () => {
    const out = parse(redactToolResult(result({ ok: true, hits: [{ chunk_text: `key ${GH} here` }] }), NONE));
    expect(out.hits[0].chunk_text).toBe(`key [REDACTED:github-token:${fingerprintSecret(GH)}] here`);
    expect(out.redacted_secrets).toBe(1);
    expect(JSON.stringify(out)).not.toContain(GH);
  });

  it("never alters identity fields, even when they look like a credential", () => {
    const identity = {
      id: GH,
      slug: `notes/${GH}`,
      source_id: GH,
      document_id: 7,
      chunk_id: GH,
      page_id: GH,
      take_key: GH,
      fact_id: 12,
      entity_slug: GH,
      fingerprint: GH,
      content_hash: GH,
      hash_prev: GH,
      hash_new: GH,
      version: 3,
      version_n: 4,
      job_id: GH,
      request_id: GH,
      plan_hash: GH,
      source_slug: GH,
      chunk_ids: [GH, GH],
    };
    const out = parse(redactToolResult(result({ ok: true, page: { ...identity, markdown_body: GH } }), NONE));
    const { markdown_body, ...rest } = out.page;
    expect(rest).toEqual(identity);
    expect(markdown_body).not.toContain(GH);
  });

  it("shares one echo dictionary across the response, both directions", () => {
    const fp = fingerprintSecret(OPAQUE);
    const out = parse(
      redactToolResult(
        result({ ok: true, hits: [{ text: `the reply was ${OPAQUE}` }, { text: `Authorization: Bearer ${OPAQUE}` }] }),
        NONE,
      ),
    );
    expect(out.hits[0].text).toBe(`the reply was [REDACTED:bearer-token-echo:${fp}]`);
    expect(out.hits[1].text).toBe(`Authorization: Bearer [REDACTED:bearer-token:${fp}]`);
    expect(JSON.stringify(out)).not.toContain(OPAQUE);
  });

  it("returns the result itself when nothing is found", () => {
    const r = result({ ok: true, hits: [{ text: "nothing to see" }], version: 2 });
    expect(redactToolResult(r, NONE)).toBe(r);
  });

  it("leaves an allowed fingerprint in place", () => {
    const r = result({ ok: true, text: GH });
    expect(redactToolResult(r, new Set([fingerprintSecret(GH)]))).toBe(r);
  });

  it("skips error results", () => {
    const r = { ...result({ error: GH }), isError: true };
    expect(redactToolResult(r, NONE)).toBe(r);
  });

  it("scans a text block that is not JSON", () => {
    const r = { content: [{ type: "text" as const, text: `plain ${GH}` }] };
    expect(redactToolResult(r, NONE).content[0]!.text).not.toContain(GH);
  });

  it("scans object keys", () => {
    const out = parse(redactToolResult(result({ ok: true, counts: { [GH]: 1 } }), NONE));
    expect(JSON.stringify(out)).not.toContain(GH);
  });

  it("cuts nesting deeper than the cap", () => {
    let deep: unknown = { text: GH };
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    const text = redactToolResult(result({ ok: true, deep }), NONE).content[0]!.text;
    expect(text).toContain(OUTPUT_LIMIT_MARKER);
    expect(text).not.toContain(GH);
  });

  it("scans a large page body instead of cutting it", () => {
    const big = `${"a ".repeat(40_000)}${GH}`;
    const out = parse(redactToolResult(result({ ok: true, slug: "notes/big", body: big }), NONE));
    expect(out.body).not.toContain(GH);
    expect(out.body).toContain("[REDACTED:github-token:");
    expect(out.body.startsWith("a a a")).toBe(true);
    expect(out.slug).toBe("notes/big");
  });

  it("stays bounded on a response over the scan budget", () => {
    const hits = Array.from({ length: 600 }, (_, i) => ({ id: i, text: `${"word ".repeat(1000)}${GH}` }));
    const r = result({ ok: true, hits });
    expect(r.content[0]!.text.length).toBeGreaterThan(MAX_RESPONSE_CHARS);
    const started = performance.now();
    const out = parse(redactToolResult(r, NONE));
    const elapsed = performance.now() - started;
    expect(JSON.stringify(out)).not.toContain(GH);
    expect(out.hits.map((h: { id: number }) => h.id)).toEqual(hits.map((h) => h.id));
    expect(out.hits.at(-1).text).toBe(OUTPUT_LIMIT_MARKER);
    expect(out.hits[0].text).toContain("[REDACTED:github-token:");
    expect(elapsed).toBeLessThan(5000);
  });

  it("stops scanning after the field cap", () => {
    const hits = Array.from<string>({ length: MAX_FIELDS + 10 }).fill(`x ${GH}`);
    const out = parse(redactToolResult(result({ ok: true, hits }), NONE));
    expect(out.hits.at(-1)).toBe(OUTPUT_LIMIT_MARKER);
    expect(out.hits[0]).toContain("[REDACTED:github-token:");
    expect(JSON.stringify(out)).not.toContain(GH);
  });
});

describe("MEMRAIN_OUTPUT_REDACTION", () => {
  it("is on by default and off for 0/false/off/no", () => {
    delete process.env.MEMRAIN_OUTPUT_REDACTION;
    expect(outputRedactionEnabled()).toBe(true);
    for (const v of ["0", "false", "off", "no"]) {
      process.env.MEMRAIN_OUTPUT_REDACTION = v;
      expect(outputRedactionEnabled()).toBe(false);
    }
    process.env.MEMRAIN_OUTPUT_REDACTION = "1";
    expect(outputRedactionEnabled()).toBe(true);
  });
});
