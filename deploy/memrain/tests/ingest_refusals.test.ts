import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerIngestCaptureHandler, INGEST_CAPTURE_JOB_KIND, TRANSCRIPTS_INGEST_JOB_KIND } from "../src/http/ingest.ts";
import { getHandler } from "../src/core/jobs/handlers.ts";
import { UnrecoverableJobError } from "../src/core/jobs/types.ts";
import { classifyJobError } from "../src/core/jobs/error-classify.ts";
import * as dispatch from "../src/mcp/dispatch.ts";
import { mintIngestPat } from "./helpers/ingest-principal.ts";

const ctx = { job: {} as never };
const event = { source_id: "default", source_kind: "webhook", source_uri: "test:refusal", received_at: "2026-01-01T00:00:00Z", content_type: "text/markdown", content: "capture", content_hash: new Bun.CryptoHasher("sha256").update("capture").digest("hex"), untrusted_payload: true };
const session = { format: "claude-code", id: "fixture", title: "Task", startedAt: null, messages: [{ id: "u", role: "user", speaker: "User", text: "Task", ts: null }] };
for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`ingest refusals ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  let principal: unknown;
  beforeAll(async () => {
    db = await engine.open();
    registerIngestCaptureHandler(db.storage);
    principal = (await mintIngestPat(db.storage.engine())).auth.principal;
  });
  afterAll(async () => { await db.close(); });
  it("does not retry malformed payloads or transcript prefix refusals", async () => {
    const cases = [
      [INGEST_CAPTURE_JOB_KIND, {}],
      [INGEST_CAPTURE_JOB_KIND, { event: { ...event, content_hash: "bad" } }],
      [TRANSCRIPTS_INGEST_JOB_KIND, { sessions: [session] }],
      [TRANSCRIPTS_INGEST_JOB_KIND, { source_id: "default", sessions: [] }],
      [TRANSCRIPTS_INGEST_JOB_KIND, { source_id: "default", sessions: [session], bound_slug_prefixes: [1] }],
      [TRANSCRIPTS_INGEST_JOB_KIND, { source_id: "default", sessions: [session], bound_slug_prefixes: ["notes/"] }],
    ] as const;
    for (const [kind, payload] of cases) await expect(getHandler(kind)!(payload, ctx)).rejects.toThrow(UnrecoverableJobError);
  });
  for (const code of ["permission_denied", "insufficient_scope", "invalid_params", "secret_detected", "quarantined", "page_shrink_refused", "version_conflict", "db_busy", "db_timeout", "storage_error"]) {
    it(`classifies page_put ${code}`, async () => {
      const terminal = !["version_conflict", "db_busy", "db_timeout", "storage_error"].includes(code);
      const spy = spyOn(dispatch, "dispatchTool").mockResolvedValue({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: "fixture detail" }) }] });
      try {
        let error: unknown;
        try { await getHandler(INGEST_CAPTURE_JOB_KIND)!({ event, principal }, ctx); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof UnrecoverableJobError).toBe(terminal);
        if (terminal) expect(classifyJobError(`unrecoverable: ${(error as Error).message}`)).toBe("refused");
      } finally { spy.mockRestore(); }
    });
  }
});
