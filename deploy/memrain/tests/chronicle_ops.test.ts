/**
 * Life Chronicle MCP surface — timeline reads, per-entity dimensional ontology,
 * the operator backfill sweep, and the on-write chronicle backstop. Drives the
 * real `dispatchTool` path over PGLite (no Bedrock): each op is registered in
 * TOOL_DEFS, returns real data, enforces its scope/operator gates, and (for the
 * ontology reads) strips diary-sourced + private rows for non-operator callers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool, type ToolCallResult } from "../src/mcp/dispatch.ts";
import { TOOL_DEFS } from "../src/mcp/tool_defs.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { upsertEventProjection } from "../src/core/chronicle.ts";
import { valueHash } from "../src/core/chronicle/ontology.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";

let tmp: string;
let storage: Storage;

const A = "chron-a";
const B = "chron-b";
const DAY = "2026-07-01";

function auth(sourceId: string, scopes: string[] = ["read", "write"]): AuthInfo {
  return {
    token: `tok-${sourceId}`,
    clientId: `client-${sourceId}`,
    scopes,
    sourceId,
    allowedSources: [sourceId],
    isPublic: false,
  };
}

function payload(result: ToolCallResult): any {
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]!.text);
}

async function call(
  name: string,
  args: Record<string, unknown>,
  authInfo?: AuthInfo,
): Promise<ToolCallResult> {
  return dispatchTool(storage, { name, arguments: args }, authInfo ? { authInfo } : {});
}

async function seedEvent(
  source: string,
  n: number,
  kind: string,
  who: string[],
  summary: string,
): Promise<void> {
  const depth = `meetings/${source}-${n}`;
  const event = `life/events/${source}-${n}`;
  const body = `${summary} — full meeting notes recorded for the chronicle timeline, covering agenda, decisions, and follow-up action items for everyone.`;
  await putPage(storage, {
    slug: depth,
    type: "meeting",
    title: summary,
    markdown_body: body,
    source_id: source,
  });
  await putPage(storage, {
    slug: event,
    type: "event",
    title: summary,
    compiled_truth: { event: { kind, who } },
    markdown_body: "event projection",
    source_id: source,
  });
  await upsertEventProjection(storage, {
    depthSlug: depth,
    eventSlug: event,
    dateISO: DAY,
    summary,
    sourceId: source,
  });
}

/** Insert a live (open, active, world) dimensional ontology row directly, so a
 *  genuine two-value conflict can be staged that mergeOntologyFact's forward
 *  supersession would otherwise collapse into a single current value. */
async function seedOntologyRow(
  source: string,
  entity: string,
  dimension: string,
  value: string,
  sourceSlug: string,
  visibility: "world" | "private" = "world",
): Promise<void> {
  await storage.engine().query(
    `INSERT INTO entity_facts
       (entity_slug, fact, kind, visibility, dimension, value, value_hash,
        dim_status, confidence, source_slug, valid_from, source_id)
     VALUES ($1, $2, 'fact', $8, $3, $4, $5, 'active', 0.8, $6, CURRENT_DATE, $7)`,
    [entity, `${dimension}: ${value}`, dimension, value, valueHash(value), sourceSlug, source, visibility],
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-chronicle-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  await registerSource(storage.engine(), { id: A, kind: "vault", pathPrefix: "/tenant-a" });
  await registerSource(storage.engine(), { id: B, kind: "vault", pathPrefix: "/tenant-b" });

  await seedEvent(A, 1, "meeting", ["people/alice"], "Kickoff with Alice");

  // Diary-slugged timeline row (manually projected onto a diary depth page):
  // operator-visible, filtered for a non-operator caller (excludeDiary).
  await putPage(storage, {
    slug: "life/diary/2026-07-05",
    type: "diary",
    title: "Diary",
    markdown_body: "Private interiority kept verbatim, long enough to exist as a real page body here.",
    source_id: A,
  });
  await putPage(storage, {
    slug: "life/events/diary-evt",
    type: "event",
    title: "Reflection",
    compiled_truth: { event: { kind: "reflection", who: [] } },
    markdown_body: "event projection",
    source_id: A,
  });
  await upsertEventProjection(storage, {
    depthSlug: "life/diary/2026-07-05",
    eventSlug: "life/events/diary-evt",
    dateISO: "2026-07-05",
    summary: "Private reflection",
    sourceId: A,
  });

  // Redaction fixtures: entity with a normal (world) row + a diary-sourced row.
  await seedOntologyRow(A, "people/redact", "role", "advisor", "reports/x");
  await seedOntologyRow(A, "people/redact", "mood", "anxious", "life/diary/2026-07-01");
  // Conflict fixture: two open values on one dimension, one diary-sourced. After
  // diary stripping it degenerates to a single value and must be dropped.
  await seedOntologyRow(A, "people/conflict", "role", "advisor", "reports/y");
  await seedOntologyRow(A, "people/conflict", "role", "investor", "life/diary/z");
  // Single-source degeneration fixture: two non-diary values SHARE one source
  // plus a diary value from a second source. Pre-strip it is a real conflict
  // (3 values / 2 sources); after diary stripping the survivors come from ONE
  // source, so the distinct-source predicate must drop it for a tenant.
  await seedOntologyRow(A, "people/single-src", "role", "advisor", "reports/a");
  await seedOntologyRow(A, "people/single-src", "role", "investor", "reports/a");
  await seedOntologyRow(A, "people/single-src", "role", "founder", "life/diary/q");
  // worldOnly fixtures: a private-visibility axis (only visible to the operator)
  // and a conflict whose second value is private (degenerate for a tenant).
  await seedOntologyRow(A, "people/private-dim", "secret_axis", "hidden", "reports/p", "private");
  await seedOntologyRow(A, "people/priv-conflict", "role", "advisor", "reports/pa", "world");
  await seedOntologyRow(A, "people/priv-conflict", "role", "investor", "reports/pb", "private");

  // A diary→world edge: the graph/slug reads must hide the diary endpoint from a
  // non-operator caller while the operator still sees it.
  await call("link", {
    source_slug: "life/diary/2026-07-05",
    target_slug: "meetings/chron-a-1",
    type: "related_to",
  });

  // Fuzzy-resolution fixtures: a WORLD page and a DIARY page sharing a
  // distinctive title token ("bluebird") so a fuzzy query is ambiguous between
  // exactly those two — and a date-shaped query that matches only diary slugs.
  await putPage(storage, {
    slug: "notes/bluebird",
    type: "note",
    title: "Bluebird note",
    markdown_body: "A world-visible note titled bluebird, long enough to be a real page body for the test.",
    source_id: A,
  });
  await putPage(storage, {
    slug: "life/diary/2026-07-07",
    type: "diary",
    title: "Bluebird entry",
    markdown_body: "A private diary entry titled bluebird, kept verbatim and long enough to be a real body.",
    source_id: A,
  });
});

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("tool registration", () => {
  it("registers all ten chronicle tools in TOOL_DEFS", () => {
    const names = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of [
      "chronicle_day",
      "chronicle_since",
      "chronicle_on_this_day",
      "chronicle_last_seen",
      "ontology_get",
      "ontology_propose",
      "ontology_dimensions",
      "ontology_conflicts",
      "volunteer_chronicle",
      "chronicle_backfill",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("chronicle timeline reads", () => {
  it("chronicle_day returns the projected event for the day (operator)", async () => {
    const p = payload(await call("chronicle_day", { date: DAY }));
    expect(p.ok).toBe(true);
    expect(p.events.length).toBe(1);
    expect(p.events[0].summary).toBe("Kickoff with Alice");
    expect(p.events[0].kind).toBe("meeting");
    expect(p.narrative).toBeUndefined();
  });

  it("chronicle_day narrative:true also renders prose", async () => {
    const p = payload(await call("chronicle_day", { date: DAY, narrative: true }));
    expect(typeof p.narrative).toBe("string");
    expect(p.narrative).toContain("Kickoff with Alice");
  });

  it("chronicle_since returns events at/after the bound", async () => {
    const p = payload(await call("chronicle_since", { since: "2026-06-01" }));
    expect(p.ok).toBe(true);
    expect(p.events.map((e: any) => e.summary)).toContain("Kickoff with Alice");
  });

  it("chronicle_last_seen resolves an entity to a days_ago", async () => {
    const p = payload(await call("chronicle_last_seen", { entity: "people/alice" }));
    expect(p.ok).toBe(true);
    expect(p.last_date).toBe(DAY);
    expect(typeof p.days_ago).toBe("number");
  });
});

describe("ontology write + read round-trip", () => {
  it("ontology_propose then ontology_get round-trips under a write-scoped token", async () => {
    const w = payload(
      await call(
        "ontology_propose",
        { entity: "people/bob", dimension: "role", value: "founder", visibility: "world" },
        auth(A),
      ),
    );
    expect(w.ok).toBe(true);
    expect(["inserted", "corroborated", "superseded_prior"]).toContain(w.action);

    const r = payload(await call("ontology_get", { entity: "people/bob" }, auth(A)));
    expect(r.ok).toBe(true);
    const role = r.ontology.find((x: any) => x.dimension === "role");
    expect(role?.value).toBe("founder");
  });

  it("ontology_dimensions surfaces the used axes", async () => {
    const p = payload(await call("ontology_dimensions", {}));
    expect(p.ok).toBe(true);
    expect(p.dimensions.map((d: any) => d.dimension)).toContain("role");
  });
});

describe("scope + operator gates", () => {
  it("a read-scoped token calling ontology_propose is insufficient_scope", async () => {
    const r = await call(
      "ontology_propose",
      { entity: "people/x", dimension: "role", value: "advisor" },
      auth(A, ["read"]),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("insufficient_scope");
  });

  it("a tenant token calling chronicle_backfill is permission_denied", async () => {
    const r = await call("chronicle_backfill", { dry_run: true }, auth(A));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("permission_denied");
  });

  it("chronicle_backfill dry_run counts eligible pages (operator)", async () => {
    const p = payload(await call("chronicle_backfill", { dry_run: true }));
    expect(p.ok).toBe(true);
    expect(p.dry_run).toBe(true);
    // The seeded meetings/* pages are conversation-shape; event/ pages are not.
    expect(p.eligible).toBeGreaterThanOrEqual(1);
    expect(p.pages_enqueued).toBe(0);
    // Cost guardrail: the per-page budget must be surfaced for worst-case math.
    expect(typeof p.per_page_budget_usd).toBe("number");
    expect(p.per_page_budget_env).toBe("MEMRAIN_CHRONICLE_WRITE_BUDGET_USD");
  });
});

describe("diary redaction (security-critical)", () => {
  it("operator ontology_get sees the diary-sourced row; a tenant token does not", async () => {
    const op = payload(await call("ontology_get", { entity: "people/redact" }));
    const opDims = op.ontology.map((x: any) => x.dimension);
    expect(opDims).toContain("role");
    expect(opDims).toContain("mood"); // diary-sourced, visible to the operator

    const tenant = payload(await call("ontology_get", { entity: "people/redact" }, auth(A)));
    const tDims = tenant.ontology.map((x: any) => x.dimension);
    expect(tDims).toContain("role");
    expect(tDims).not.toContain("mood"); // diary value stripped for a tenant
    expect(JSON.stringify(tenant)).not.toContain("life/diary/");
  });

  it("ontology_conflicts drops a conflict that degenerates after diary stripping", async () => {
    const op = payload(await call("ontology_conflicts", {}));
    const opConflict = op.conflicts.find((c: any) => c.entity_slug === "people/conflict");
    expect(opConflict).toBeDefined();
    expect(opConflict.values.length).toBe(2);

    const tenant = payload(await call("ontology_conflicts", {}, auth(A)));
    const tConflict = tenant.conflicts.find((c: any) => c.entity_slug === "people/conflict");
    expect(tConflict).toBeUndefined(); // one value left → not a conflict → dropped
    expect(JSON.stringify(tenant)).not.toContain("life/diary/");
  });

  it("a diary-slugged timeline row is operator-visible but hidden from an OAuth caller", async () => {
    const op = payload(await call("chronicle_day", { date: "2026-07-05" }));
    expect(op.events.map((e: any) => e.summary)).toContain("Private reflection");

    const tenant = payload(await call("chronicle_day", { date: "2026-07-05" }, auth(A)));
    expect(tenant.events.map((e: any) => e.summary)).not.toContain("Private reflection");
    expect(JSON.stringify(tenant)).not.toContain("Private reflection");
  });

  it("ontology_conflicts drops a conflict whose survivors share one source", async () => {
    const op = payload(await call("ontology_conflicts", {}));
    const opConflict = op.conflicts.find((c: any) => c.entity_slug === "people/single-src");
    expect(opConflict).toBeDefined(); // 3 values / 2 sources → a real conflict

    const tenant = payload(await call("ontology_conflicts", {}, auth(A)));
    const tConflict = tenant.conflicts.find((c: any) => c.entity_slug === "people/single-src");
    // Two values remain after diary stripping, but both from reports/a — a
    // single-source "conflict" must be dropped (distinct-source predicate).
    expect(tConflict).toBeUndefined();
  });
});

describe("worldOnly visibility fence", () => {
  it("ontology_dimensions hides a private-only axis from an OAuth caller", async () => {
    const op = payload(await call("ontology_dimensions", {}));
    expect(op.dimensions.map((d: any) => d.dimension)).toContain("secret_axis");

    const tenant = payload(await call("ontology_dimensions", {}, auth(A)));
    expect(tenant.dimensions.map((d: any) => d.dimension)).not.toContain("secret_axis");
  });

  it("ontology_conflicts never exposes a private-visibility conflict value to a tenant", async () => {
    const op = payload(await call("ontology_conflicts", {}));
    const opConflict = op.conflicts.find((c: any) => c.entity_slug === "people/priv-conflict");
    expect(opConflict).toBeDefined();
    expect(opConflict.values.map((v: any) => v.value)).toContain("investor");

    const tenant = payload(await call("ontology_conflicts", {}, auth(A)));
    const tConflict = tenant.conflicts.find((c: any) => c.entity_slug === "people/priv-conflict");
    expect(tConflict).toBeUndefined(); // private value excluded → degenerate → dropped
    expect(JSON.stringify(tenant)).not.toContain("investor");
  });
});

describe("date validation", () => {
  it("a junk ontology_get asof is clean invalid_params, not a cast error", async () => {
    const r = await call("ontology_get", { entity: "people/redact", asof: "not-a-date" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid_params");
  });

  it("a junk ontology_propose valid_from is clean invalid_params", async () => {
    const r = await call(
      "ontology_propose",
      { entity: "people/bob", dimension: "role", value: "founder", valid_from: "last week" },
      auth(A),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid_params");
  });
});

describe("tenancy isolation", () => {
  it("a caller scoped to B never sees source A's chronicle rows", async () => {
    const b = payload(await call("chronicle_day", { date: DAY }, auth(B)));
    expect(b.events.length).toBe(0);

    const a = payload(await call("chronicle_day", { date: DAY }, auth(A)));
    expect(a.events.map((e: any) => e.summary)).toContain("Kickoff with Alice");
  });

  it("a grantless authed token gets EMPTY chronicle reads (no whole-brain fail-open)", async () => {
    // authInfo present but no read grant → readSources resolves undefined; the
    // remote fail-closed path must return the sentinel, NOT expand to whole-brain.
    const grantless: AuthInfo = {
      token: "tok-grantless",
      clientId: "client-grantless",
      scopes: ["read"],
      allowedSources: [],
      isPublic: false,
    };
    const day = payload(await call("chronicle_day", { date: DAY }, grantless));
    expect(day.events.length).toBe(0);
    const onto = payload(await call("ontology_get", { entity: "people/redact" }, grantless));
    expect(onto.ontology.length).toBe(0);
    const dims = payload(await call("ontology_dimensions", {}, grantless));
    expect(dims.dimensions.length).toBe(0);
  });
});

describe("on-write chronicle backstop", () => {
  it("enqueues nothing when MEMRAIN_AUTO_CHRONICLE is unset", async () => {
    delete process.env["MEMRAIN_AUTO_CHRONICLE"];
    const p = payload(
      await call("page_put", {
        slug: "meetings/backstop-off",
        type: "meeting",
        markdown_body:
          "Standup with the team about the roadmap and the next release, going over blockers, owners, and the timeline for each workstream in detail.",
      }),
    );
    expect(p.chronicle_backstop).toBeUndefined();
    const jobs = await storage.engine().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'chronicle_extract'`,
    );
    expect(jobs.rows[0]!.n).toBe(0);
  });

  it("enqueues one chronicle_extract job when MEMRAIN_AUTO_CHRONICLE=1", async () => {
    process.env["MEMRAIN_AUTO_CHRONICLE"] = "1";
    try {
      const p = payload(
        await call("page_put", {
          slug: "meetings/backstop-on",
          type: "meeting",
          markdown_body:
            "Retro with the team covering what shipped and what stalled this week, plus lessons learned and the concrete changes we agreed to make next sprint.",
        }),
      );
      expect(p.chronicle_backstop).toBe(true);
      const jobs = await storage.engine().query<{ kind: string; payload: any }>(
        `SELECT kind, payload FROM jobs WHERE kind = 'chronicle_extract'`,
      );
      expect(jobs.rows.length).toBe(1);
      const jp =
        typeof jobs.rows[0]!.payload === "string"
          ? JSON.parse(jobs.rows[0]!.payload)
          : jobs.rows[0]!.payload;
      expect(jp.slug).toBe("meetings/backstop-on");
    } finally {
      delete process.env["MEMRAIN_AUTO_CHRONICLE"];
    }
  });

  it("gives a failed extraction of the same text another run", async () => {
    process.env["MEMRAIN_AUTO_CHRONICLE"] = "1";
    const markdown_body =
      "Planning session with the team on the quarter's goals, the owners for each one, the risks we see, and how we will check progress every week.";
    try {
      await call("page_put", { slug: "meetings/backstop-revive", type: "meeting", markdown_body });
      await storage.engine().query(
        `UPDATE jobs SET status = 'failed', last_error = 'boom' WHERE id LIKE '%:meetings/backstop-revive:%'`,
      );
      // The same text again: a no-op put is not a change, so append-then-restore.
      await call("page_put", { slug: "meetings/backstop-revive", type: "meeting", markdown_body: `${markdown_body} More.` });
      await call("page_put", { slug: "meetings/backstop-revive", type: "meeting", markdown_body });
      const jobs = await storage.engine().query<{ status: string }>(
        `SELECT status FROM jobs WHERE id LIKE '%:meetings/backstop-revive:%' ORDER BY created_at`,
      );
      expect(jobs.rows.map((j) => j.status)).toEqual(["pending", "pending"]);
    } finally {
      delete process.env["MEMRAIN_AUTO_CHRONICLE"];
    }
  });
});

describe("direct page-read diary fence", () => {
  const DIARY = "life/diary/2026-07-05"; // seeded diary page (type diary)

  it("page_get on a diary page is not_found for a tenant, readable by the operator", async () => {
    const op = payload(await call("page_get", { slug: DIARY }));
    expect(op.page.slug).toBe(DIARY);

    const tenant = await call("page_get", { slug: DIARY }, auth(A));
    expect(tenant.isError).toBe(true);
    expect(tenant.content[0]!.text).toContain("not found");
    expect(tenant.content[0]!.text).not.toContain("Private interiority");
  });

  it("page_list hides diary pages from a tenant but not the operator", async () => {
    const op = payload(await call("page_list", { limit: 100 }));
    expect(op.pages.map((p: any) => p.slug)).toContain(DIARY);

    const tenant = payload(await call("page_list", { limit: 100 }, auth(A)));
    expect(tenant.pages.map((p: any) => p.slug)).not.toContain(DIARY);
    expect(JSON.stringify(tenant)).not.toContain("Private interiority");
  });

  it("page_versions / get_chunks / entity_recall / get_raw_data hide diary content from a tenant", async () => {
    const pv = payload(await call("page_versions", { slug: DIARY }, auth(A)));
    expect(pv.versions).toEqual([]);
    const gc = payload(await call("get_chunks", { slug: DIARY }, auth(A)));
    expect(gc.chunks).toEqual([]);
    const er = payload(await call("entity_recall", { slug: DIARY }, auth(A)));
    expect(er.page).toBeNull();
    const rd = payload(await call("get_raw_data", { slug: DIARY }, auth(A)));
    expect(rd.raw_data).toEqual([]);
    // Operator still reads the version chain.
    const opv = payload(await call("page_versions", { slug: DIARY }));
    expect(opv.versions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("chronicle_backfill content-addressed dedup", () => {
  async function jobsFor(slug: string): Promise<number> {
    const r = await storage.engine().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM jobs WHERE kind = 'chronicle_extract' AND payload->>'slug' = $1`,
      [slug],
    );
    return r.rows[0]!.n;
  }

  it("re-sweep of identical content enqueues no duplicate; an edit enqueues a new job", async () => {
    const slug = "meetings/backfill-dedup";
    await call("page_put", {
      slug,
      type: "meeting",
      markdown_body:
        "First backfill body — meeting notes long enough to be chronicle-eligible for extraction, covering the agenda and the follow-up items in detail.",
    });
    await call("chronicle_backfill", {});
    const c1 = await jobsFor(slug);
    expect(c1).toBe(1);

    // Same content → same content-hash id → ON CONFLICT DO NOTHING → no dup.
    await call("chronicle_backfill", {});
    expect(await jobsFor(slug)).toBe(1);

    // Edit → new content hash → new id → a fresh job (the dedup-forever bug fix).
    await call("page_put", {
      slug,
      type: "meeting",
      markdown_body:
        "Second backfill body — the same meeting notes edited with an extra decision recorded, still comfortably long enough to stay chronicle-eligible.",
    });
    await call("chronicle_backfill", {});
    expect(await jobsFor(slug)).toBe(2);
  });

  it("rejects a limit above the 500 hard cap at the contract boundary", async () => {
    const r = await call("chronicle_backfill", { dry_run: true, limit: 999 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("invalid_params");
  });
});

describe("graph/slug diary fence", () => {
  const DIARY = "life/diary/2026-07-05";
  const TARGET = "meetings/chron-a-1";

  it("a diary→world edge is visible to the operator, hidden from a tenant", async () => {
    const opLinks = payload(await call("get_links", { slug: TARGET }));
    expect(JSON.stringify(opLinks)).toContain(DIARY);
    const tLinks = payload(await call("get_links", { slug: TARGET }, auth(A)));
    expect(JSON.stringify(tLinks)).not.toContain(DIARY);

    const opN = payload(await call("graph_neighbors", { slug: TARGET }));
    expect(JSON.stringify(opN)).toContain(DIARY);
    const tN = payload(await call("graph_neighbors", { slug: TARGET }, auth(A)));
    expect(JSON.stringify(tN)).not.toContain(DIARY);
  });

  it("resolve_slugs never returns a diary slug to a tenant", async () => {
    const op = payload(await call("resolve_slugs", { query: "diary" }));
    expect(op.hits.map((h: any) => h.slug)).toContain(DIARY);
    const t = payload(await call("resolve_slugs", { query: "diary" }, auth(A)));
    expect(t.hits.map((h: any) => h.slug)).not.toContain(DIARY);
  });

  it("get_links / graph_neighbors on a diary slug are empty for a tenant", async () => {
    const gl = payload(await call("get_links", { slug: DIARY }, auth(A)));
    expect(gl.groups).toEqual([]);
    const gn = payload(await call("graph_neighbors", { slug: DIARY }, auth(A)));
    expect(gn.links).toEqual([]);
  });
});

describe("fuzzy page_get ambiguity diary fence", () => {
  it("resolves to the world page when a diary + world both match — no ambiguity leak to a tenant", async () => {
    // Operator: the ambiguity list still names the diary slug.
    const op = payload(await call("page_get", { slug: "bluebird", fuzzy: true }));
    expect(op.error).toBe("ambiguous_slug");
    expect(op.candidates.some((s: string) => s.startsWith("life/diary/"))).toBe(true);

    // Tenant: diary candidates stripped BEFORE branching → only the world page
    // remains → it resolves outright, and no life/diary/* slug is ever echoed.
    const t = payload(await call("page_get", { slug: "bluebird", fuzzy: true }, auth(A)));
    expect(t.ok).toBe(true);
    expect(t.page.slug).toBe("notes/bluebird");
    expect(JSON.stringify(t)).not.toContain("life/diary/");
  });

  it("is not_found for a tenant when only diary pages match", async () => {
    const t = await call("page_get", { slug: "2026-07-07", fuzzy: true }, auth(A));
    expect(t.isError).toBe(true);
    expect(t.content[0]!.text).toContain("not found");
    expect(t.content[0]!.text).not.toContain("life/diary/");
  });
});
