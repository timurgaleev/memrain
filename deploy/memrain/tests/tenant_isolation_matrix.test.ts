/**
 * Isolation matrix — every MCP operation, every caller shape.
 *
 * `tests/fixtures/tenant_isolation_matrix.ts` holds one row per operation; this
 * suite first proves the table covers the registry exactly, then drives each
 * row through the real `dispatchTool`:
 *
 *   isolated       the operator (no authInfo) must see a tenant-B token — else
 *                  the row is VACUOUS and fails — and each tenant must see
 *                  its own data through the same read pointed at its side, so an
 *                  over-filtering read cannot pass. None of these may cross:
 *                    scalar       tenant A via sourceId, reading B's side
 *                    federated    tenant A via allowedSources only
 *                    scalar B     tenant B via sourceId, reading A's side
 *                    no grant     an authenticated caller with no source, fail-closed on
 *                    empty grant  allowedSources: [], fail-closed on
 *   brainwide      scoped callers get an answer, never a thrown error
 *   operator_only  every token caller is refused
 *
 * A leak is any tenant-B token anywhere in the serialized envelope (content,
 * structured fields, error text), except tokens the caller itself passed in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { addFact } from "../src/core/facts.ts";
import { dispatchTool, OPERATOR_ONLY_TOOLS, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { OPERATIONS, WRITE_SCOPED_TOOLS } from "../src/mcp/operations.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { deterministicEmbed } from "./det-embed.ts";
import { A, auth, B, ENTITY_SLUG, KEYWORD, seedTenantContract } from "./helpers/tenant_seed.ts";
import { MATRIX, type MatrixRow, TENANT_A_TOKENS, TENANT_B_TOKENS } from "./fixtures/tenant_isolation_matrix.ts";

setDefaultTimeout(60000);

let tmp: string;
let storage: Storage;
let factIdA = 0;
let factIdB = 0;

// Chronicle reads are windowed around "now"; derive the seed dates from it.
const DAY = 86_400_000;
const recentDate = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
const nextYear = new Date(`${recentDate}T00:00:00Z`);
nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
const nextYearDate = nextYear.toISOString().slice(0, 10);
const PLACEHOLDERS: Record<string, unknown> = { $recentDate: recentDate, $nextYearDate: nextYearDate };

const federatedA: AuthInfo = { ...auth(A), sourceId: undefined, allowedSources: [A] };
const noGrant: AuthInfo = { token: "tok-none", clientId: "client-none", scopes: ["read"], isPublic: false };
const emptyGrant: AuthInfo = {
  token: "tok-empty-grant", clientId: "client-empty-grant", scopes: ["read"], allowedSources: [], isPublic: false,
};
const embedQuery = async (text: string) => deterministicEmbed(text);

function argsFor(row: { args: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row.args).map(([k, v]) => {
    if (v === "$factIdB") return [k, factIdB];
    return [k, typeof v === "string" && v in PLACEHOLDERS ? PLACEHOLDERS[v] : v];
  }));
}

// The same read pointed at tenant A's side of the seed, for the positive control.
function ownArgsFor(row: { args: Record<string, unknown> }): Record<string, unknown> {
  return Object.fromEntries(Object.entries(argsFor(row)).map(([k, v]) => {
    if (row.args[k] === "$factIdB") return [k, factIdA];
    return [k, typeof v === "string" ? v.replace("team-b/", "team-a/").replace(B, A) : v];
  }));
}

async function call(name: string, args: Record<string, unknown>, authInfo?: AuthInfo): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo, embedQuery } : { embedQuery });
}

function leakedToken(
  result: ToolCallResult,
  args: Record<string, unknown>,
  tokens: readonly string[] = TENANT_B_TOKENS,
): string | undefined {
  const echoed = JSON.stringify(args).toLowerCase();
  const body = JSON.stringify(result).toLowerCase();
  return tokens.find(t => !echoed.includes(t.toLowerCase()) && body.includes(t.toLowerCase()));
}

async function seedMatrixExtras(): Promise<void> {
  for (const [who, tag] of [[A, "AAA"], [B, "BBB"]] as const) {
    const a = auth(who);
    const slug = who === A ? "team-a/alice" : "team-b/alice";
    await call("put_raw_data", { slug, source: "matrix", data: { note: `${tag}_RAW_note` } }, a);
    await call("log_ingest", { source_type: "matrix", source_ref: `${tag}_INGEST_ref`, summary: `${tag}_INGEST_summary` }, a);
    await call("ontology_propose", { entity: ENTITY_SLUG, dimension: "role", value: `${tag}_ONTO_first`, visibility: "world" }, a);
    await call("ontology_propose", { entity: ENTITY_SLUG, dimension: "role", value: `${tag}_ONTO_second`, visibility: "world" }, a);
    await call("add_tag", { slug, tag: `${tag}_TAG_label` }, a);
    await call("add_timeline_event", { slug, occurred_at: `${recentDate}T12:00:00Z`, event: `${tag}_EVENT_recent` }, a);
    // A retired fact with a replacement pointer is what the supersession audit lists.
    const kept = await call("add_fact", { entity_slug: slug, fact: `${tag}_FACT_current`, visibility: "world" }, a);
    const old = await call("add_fact", { entity_slug: slug, fact: `${tag}_FACT_retired`, visibility: "world" }, a);
    const id = (r: ToolCallResult) => Number(JSON.parse(r.content[0]!.text).id);
    await storage.engine().query(
      `UPDATE entity_facts SET forgotten_at = NOW(), superseded_by = $2 WHERE id = $1`,
      [id(old), id(kept)],
    );
    // Token callers read world facts only; give each tenant one on the shared entity.
    await addFact(storage, { entity_slug: ENTITY_SLUG, fact: `${tag}_FACT_world`, source_id: who, visibility: "world" });
    await addFact(storage, { entity_slug: ENTITY_SLUG, fact: `${KEYWORD} ${tag}_QUERY_FACT`, source_id: who, visibility: "world" });
  }
  await call("chronicle_backfill", {});
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-isolation-matrix-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  ({ factIdA, factIdB } = await seedTenantContract(storage));
  await seedMatrixExtras();
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
});

describe("isolation matrix covers the registry", () => {
  it("has exactly one row per operation", () => {
    const names = MATRIX.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(OPERATIONS.map(o => o.name).sort());
  });

  it("marks exactly the operator-only tools operator_only", () => {
    const rows = MATRIX.filter(r => r.mode === "operator_only").map(r => r.name).sort();
    expect(rows).toEqual([...OPERATOR_ONLY_TOOLS].filter(n => !WRITE_SCOPED_TOOLS.has(n)).sort());
  });

  it("marks exactly the write-scoped tools write", () => {
    const rows = MATRIX.filter(r => r.mode === "write").map(r => r.name).sort();
    expect(rows).toEqual([...WRITE_SCOPED_TOOLS].sort());
  });

  it("names an existing owner suite for every skipped row", () => {
    for (const row of MATRIX) {
      if (row.mode === "skip") expect(existsSync(join(import.meta.dir, "..", row.owner))).toBe(true);
    }
  });
});

const byMode = <M extends MatrixRow["mode"]>(mode: M) =>
  MATRIX.filter((r): r is Extract<MatrixRow, { mode: M }> => r.mode === mode);

describe("isolated operations never cross the source boundary", () => {
  for (const row of byMode("isolated")) {
    it(row.name, async () => {
      const args = argsFor(row);
      const ownArgs = ownArgsFor(row);
      const sees = async (rowArgs: Record<string, unknown>, tokens: readonly string[], authInfo?: AuthInfo) =>
        leakedToken(await call(row.name, rowArgs, authInfo), rowArgs, tokens) !== undefined;
      if (!(await sees(args, TENANT_B_TOKENS))) {
        throw new Error(`VACUOUS: the operator sees no tenant-B data through ${row.name}; fix the seed or the row`);
      }
      if (!(await sees(ownArgs, row.own ? [row.own] : TENANT_A_TOKENS, auth(A))) || !(await sees(args, TENANT_B_TOKENS, auth(B)))) {
        throw new Error(`OVER-FILTERED: a tenant sees none of its own data through ${row.name}`);
      }
      const principals: Array<[string, AuthInfo, Record<string, unknown>, readonly string[], boolean]> = [
        ["scalar", auth(A), args, TENANT_B_TOKENS, false],
        ["federated", federatedA, args, TENANT_B_TOKENS, false],
        ["scalar B", auth(B), ownArgs, TENANT_A_TOKENS, false],
        ["no grant", noGrant, args, [...TENANT_B_TOKENS, ...TENANT_A_TOKENS], true],
        ["empty grant", emptyGrant, args, [...TENANT_B_TOKENS, ...TENANT_A_TOKENS], true],
      ];
      for (const [label, authInfo, rowArgs, tokens, failClosed] of principals) {
        if (failClosed) process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = "1";
        else delete process.env["MEMRAIN_TENANT_FAIL_CLOSED"];
        const leaked = leakedToken(await call(row.name, rowArgs, authInfo), rowArgs, tokens);
        expect({ caller: label, leaked }).toEqual({ caller: label, leaked: undefined });
      }
    });
  }
});

describe("brainwide operations answer scoped callers", () => {
  for (const row of byMode("brainwide")) {
    it(row.name, async () => {
      for (const authInfo of [auth(A), federatedA]) {
        const res = await call(row.name, argsFor(row), authInfo);
        expect(JSON.stringify(res)).not.toContain("permission_denied");
      }
    });
  }
});

describe("operator-only operations refuse token callers", () => {
  for (const row of byMode("operator_only")) {
    it(row.name, async () => {
      for (const authInfo of [auth(A), federatedA]) {
        const res = await call(row.name, { id: 1, kind: "noop" }, authInfo);
        expect(res.isError).toBe(true);
        expect(JSON.stringify(res)).toContain("permission_denied");
      }
    });
  }
});

// think is write-scoped, so the fail-closed gate refuses a grantless caller
// before callThink runs; the in-handler no-grant short-circuit is the backstop.
describe("write-scoped reads refuse a grantless caller", () => {
  it("think: a grantless caller gets no synthesis and no tenant token", async () => {
    const args = { question: `what about ${KEYWORD}?` };
    const operator = JSON.parse((await call("think", args)).content[0]!.text);
    expect(operator.reason).toContain("default-OFF");

    process.env["MEMRAIN_TENANT_FAIL_CLOSED"] = "1";
    const res = await call("think", args, emptyGrant);
    expect(leakedToken(res, args, [...TENANT_B_TOKENS, ...TENANT_A_TOKENS])).toBeUndefined();
    const out = JSON.parse(res.content[0]!.text);
    expect(out.error).toBe("permission_denied");
    expect(out.synthesis).toBeUndefined();
  });
});
