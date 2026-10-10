/**
 * POST /ingest webhook capture endpoint + the `ingest_capture` job handler.
 * Covers: OAuth write-scope gate, byte cap, content-type allowlist,
 * content-hash idempotent job submission (202 + job_id), rate limiting,
 * and the worker handler landing the capture as an inbox page stamped
 * with the caller's write source.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { getPage } from "../src/core/pages.ts";
import { getHandler, _resetHandlersForTesting } from "../src/core/jobs/handlers.ts";
import type { JobRow } from "../src/core/jobs/types.ts";
import {
  handleIngestRoute,
  registerIngestCaptureHandler,
  defaultSlugForEvent,
  resolveIngestContentType,
  INGEST_CAPTURE_JOB_KIND,
  type IngestionEvent,
} from "../src/http/ingest.ts";

let tmp: string;
let storage: Storage;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-ingest-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.MEMRAIN_INGEST_MAX_BYTES;
  _resetHandlersForTesting();
});

const writeAuth: AuthInfo = {
  token: "t",
  clientId: "shortcuts-client",
  scopes: ["write"],
  sourceId: "default",
  isPublic: false,
};

function ingestReq(
  body: string,
  headers: Record<string, string> = { "content-type": "text/markdown" },
): Request {
  return new Request("http://test/ingest", { method: "POST", headers, body });
}

function deps(auth?: AuthInfo, allow = true) {
  return {
    storage,
    ...(auth !== undefined ? { authInfo: auth } : {}),
    allowRequest: () => allow,
    clientIp: "1.2.3.4",
  };
}

async function jobRows(): Promise<Array<{ id: string; kind: string }>> {
  const r = await storage
    .engine()
    .query<{ id: string; kind: string }>("SELECT id, kind FROM jobs ORDER BY created_at");
  return r.rows;
}

/** Wait for a detached insert into `table` to land, rather than sleeping a fixed guess. */
async function landed(table: "mcp_request_log" | "ingest_log"): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const hit = await storage.engine().query(`SELECT 1 FROM ${table} LIMIT 1`);
    if (hit.rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("POST /ingest route", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await handleIngestRoute(ingestReq("# hi"), deps(undefined));
    expect(res.status).toBe(401);
  });

  it("rejects read-only OAuth tokens with 403", async () => {
    const res = await handleIngestRoute(
      ingestReq("# hi"),
      deps({ ...writeAuth, scopes: ["read"] }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
  });

  it("rejects rate-limited callers with 429", async () => {
    const res = await handleIngestRoute(ingestReq("# hi"), deps(writeAuth, false));
    expect(res.status).toBe(429);
  });

  it("rejects binary content types with 415", async () => {
    const res = await handleIngestRoute(
      ingestReq("...", { "content-type": "image/png" }),
      deps(writeAuth),
    );
    expect(res.status).toBe(415);
  });

  it("rejects bodies over the byte cap with 413", async () => {
    process.env.MEMRAIN_INGEST_MAX_BYTES = "10";
    const res = await handleIngestRoute(
      ingestReq("this body is longer than ten bytes"),
      deps(writeAuth),
    );
    expect(res.status).toBe(413);
  });

  it("rejects an empty body with 400", async () => {
    const res = await handleIngestRoute(ingestReq(""), deps(writeAuth));
    expect(res.status).toBe(400);
  });

  it("queues an idempotent ingest_capture job and returns 202 + job_id", async () => {
    const res = await handleIngestRoute(ingestReq("# captured note"), deps(writeAuth));
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      job_id: string;
      content_hash: string;
      source_id: string;
    };
    expect(body.job_id).toContain("ingest:webhook:shortcuts-client:");
    expect(body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.source_id).toBe("default");

    // Same content from the same client → the SAME durable job.
    const res2 = await handleIngestRoute(ingestReq("# captured note"), deps(writeAuth));
    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as { job_id: string };
    expect(body2.job_id).toBe(body.job_id);

    const rows = await jobRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe(INGEST_CAPTURE_JOB_KIND);

    // Different content → a different job.
    const res3 = await handleIngestRoute(ingestReq("# other note"), deps(writeAuth));
    expect(res3.status).toBe(202);
    expect((await jobRows()).length).toBe(2);
  });

  it("logs a webhook_ingest row to mcp_request_log", async () => {
    await handleIngestRoute(ingestReq("# captured"), deps(writeAuth));
    await landed("mcp_request_log");
    const r = await storage
      .engine()
      .query<{ operation: string; token_name: string }>(
        "SELECT operation, token_name FROM mcp_request_log WHERE operation = 'webhook_ingest'",
      );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.token_name).toBe("shortcuts-client");
  });

  it("refuses a client with no write grant before scanning, and audits nothing", async () => {
    const saved = {
      f: process.env.MEMRAIN_TENANT_FAIL_CLOSED,
      d: process.env.MEMRAIN_SECRET_SCAN_DISPOSITION,
    };
    process.env.MEMRAIN_TENANT_FAIL_CLOSED = "1";
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    try {
      const { sourceId: _granted, ...noGrant } = writeAuth;
      const key = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
      const res = await handleIngestRoute(ingestReq(`key ${key}`), deps(noGrant));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("permission_denied");
      await new Promise((r) => setTimeout(r, 50)); // any detached audit insert
      const audit = await storage.engine().query(`SELECT 1 FROM ingest_log`);
      expect(audit.rows).toHaveLength(0);
    } finally {
      for (const [k, v] of [["MEMRAIN_TENANT_FAIL_CLOSED", saved.f], ["MEMRAIN_SECRET_SCAN_DISPOSITION", saved.d]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("audits a granted client's rejected body under its own source", async () => {
    const saved = process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
    process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = "reject";
    try {
      await storage.engine().query(
        `INSERT INTO sources (id, kind, path_prefix) VALUES ('tenant-a', 'other', 'tenant:tenant-a')
         ON CONFLICT DO NOTHING`,
      );
      const key = ["AK", "IA", "Q3EXAMPLE7WXYZ12"].join("");
      const res = await handleIngestRoute(ingestReq(`key ${key}`), deps({ ...writeAuth, sourceId: "tenant-a" }));
      expect(res.status).toBe(400);
      await landed("ingest_log");
      const audit = await storage.engine().query<{ source_id: string }>(
        `SELECT source_id FROM ingest_log WHERE source_type = 'secret-rejected'`,
      );
      expect(audit.rows.map((r) => r.source_id)).toEqual(["tenant-a"]);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_SECRET_SCAN_DISPOSITION;
      else process.env.MEMRAIN_SECRET_SCAN_DISPOSITION = saved;
    }
  });

  it("rejects an invalid X-Memex-Slug with 400", async () => {
    const res = await handleIngestRoute(
      ingestReq("# hi", { "content-type": "text/markdown", "x-memex-slug": "Bad Slug!" }),
      deps(writeAuth),
    );
    expect(res.status).toBe(400);
  });
});

describe("content-type resolution", () => {
  it("maps the taxonomy + degrades unknown text/*", () => {
    expect(resolveIngestContentType("text/markdown; charset=utf-8")).toBe("text/markdown");
    expect(resolveIngestContentType("text/html")).toBe("text/html");
    expect(resolveIngestContentType("application/json")).toBe("application/json");
    expect(resolveIngestContentType("text/csv")).toBe("text/plain");
    expect(resolveIngestContentType("application/pdf")).toBeNull();
    expect(resolveIngestContentType("")).toBeNull();
  });
});

describe("ingest_capture job handler", () => {
  function eventFor(content: string): IngestionEvent {
    return {
      source_id: "default",
      source_kind: "webhook",
      source_uri: "test:uri",
      received_at: new Date().toISOString(),
      content_type: "text/markdown",
      content,
      content_hash: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      untrusted_payload: true,
      metadata: { client_id: "shortcuts-client" },
    };
  }

  it("lands the capture as an inbox page via page_put", async () => {
    registerIngestCaptureHandler(storage);
    const handler = getHandler(INGEST_CAPTURE_JOB_KIND);
    expect(handler).toBeDefined();
    const event = eventFor("# hello from a webhook");
    const result = (await handler!({ event }, { job: {} as JobRow })) as Record<string, unknown>;
    const slug = defaultSlugForEvent(event);
    expect(result.slug).toBe(slug);
    expect(result.untrusted_payload).toBe(true);
    const page = await getPage(storage, slug);
    expect(page?.markdown_body).toBe("# hello from a webhook");
    expect(page?.source_id).toBe("default");
  });

  it("honors a caller-provided slug", async () => {
    registerIngestCaptureHandler(storage);
    const handler = getHandler(INGEST_CAPTURE_JOB_KIND)!;
    const event = eventFor("captured with a slug");
    await handler({ event, slug: "notes/from-webhook" }, { job: {} as JobRow });
    const page = await getPage(storage, "notes/from-webhook");
    expect(page?.markdown_body).toBe("captured with a slug");
  });

  it("an aborted attempt writes no page", async () => {
    registerIngestCaptureHandler(storage);
    const handler = getHandler(INGEST_CAPTURE_JOB_KIND)!;
    const abort = new AbortController();
    abort.abort(new Error("lost its claim"));
    await expect(
      handler({ event: eventFor("abandoned capture"), slug: "notes/abandoned" }, { job: {} as JobRow, signal: abort.signal }),
    ).rejects.toThrow("lost its claim");
    expect(await getPage(storage, "notes/abandoned")).toBeNull();
  });

  it("throws on a malformed event (fails the job)", async () => {
    registerIngestCaptureHandler(storage);
    const handler = getHandler(INGEST_CAPTURE_JOB_KIND)!;
    const bad = { ...eventFor("x"), content_hash: "nope" };
    await expect(handler({ event: bad }, { job: {} as JobRow })).rejects.toThrow(
      /invalid event/,
    );
  });
});
