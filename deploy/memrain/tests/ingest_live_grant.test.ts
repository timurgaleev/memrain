/**
 * A queued capture or transcript push is written under the credential that
 * submitted it AS IT STANDS when the worker runs, not as it stood at
 * admission. The job carries a non-bearer reference to that credential (the
 * PAT row, the OAuth refresh family, or the OAuth token row); the worker
 * re-reads it and refuses for good when it was revoked, its client deleted,
 * or its grant no longer covers the write scope, the source or the slug.
 * A token that merely reached its access TTL is not revoked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import type { AuthInfo } from "../src/core/auth-info.ts";
import { OAuthProvider, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";
import { getPage } from "../src/core/pages.ts";
import { getHandler } from "../src/core/jobs/handlers.ts";
import { UnrecoverableJobError, type JobRow } from "../src/core/jobs/types.ts";
import {
  handleIngestRoute,
  INGEST_CAPTURE_JOB_KIND,
  registerIngestCaptureHandler,
  TRANSCRIPTS_INGEST_JOB_KIND,
} from "../src/http/ingest.ts";

const REDIRECT = "https://client.example/cb";
const TRANSCRIPT_CT = "application/x-memrain-transcript+jsonl";
const claudeRaw = readFileSync(join(import.meta.dir, "fixtures", "transcripts", "claude-code-session.jsonl"), "utf-8");
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`ingest live grant ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  let provider: OAuthProvider;
  let n = 0;

  beforeAll(async () => {
    db = await engine.open();
    provider = new OAuthProvider({ engine: db.storage.engine() });
    await registerSource(db.storage.engine(), { id: "acme", kind: "other", pathPrefix: "/acme" });
    await registerSource(db.storage.engine(), { id: "beta", kind: "other", pathPrefix: "/beta" });
  });
  afterAll(async () => { await db.close(); });
  beforeEach(() => { registerIngestCaptureHandler(db.storage); });

  const unique = () => `${++n}-${randomBytes(4).toString("hex")}`;

  /** What server.ts builds from a verified bearer. */
  function ingestAuth(info: Awaited<ReturnType<OAuthProvider["verifyAccessToken"]>>): AuthInfo {
    const { expiresAt: _e, resource: _r, clientName: _c, ...rest } = info;
    return { ...rest, isPublic: false };
  }

  async function mintPat(sourceId = "acme"): Promise<{ token: string; name: string }> {
    const token = `memrain_pat_${randomBytes(24).toString("hex")}`;
    const name = `pat-${unique()}`;
    await db.storage.engine().query(
      `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3::text[], $4::text::jsonb)`,
      [name, sha(token), ["read", "write"], JSON.stringify({ source_id: sourceId })],
    );
    return { token, name };
  }

  async function webClient(boundSlugPrefixes?: string[]): Promise<OAuthClientInfo> {
    const { clientId } = await provider.registerClientManual(
      `web-${unique()}`, ["authorization_code", "refresh_token"], "read write", [REDIRECT], "acme",
      undefined, undefined, boundSlugPrefixes,
    );
    return (await provider.getClient(clientId))!;
  }

  async function signIn(client: OAuthClientInfo) {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { redirectUrl } = await provider.authorize(client, { codeChallenge: challenge, redirectUri: REDIRECT });
    const code = new URL(redirectUrl).searchParams.get("code")!;
    return provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  }

  async function machineToken(): Promise<{ clientId: string; secret: string; token: string }> {
    const { clientId, clientSecret } = await provider.registerClientManual(`m2m-${unique()}`, ["client_credentials"], "read write", [], "acme");
    const minted = await provider.exchangeClientCredentials(clientId, clientSecret!);
    return { clientId, secret: clientSecret!, token: minted.access_token };
  }

  async function queuedPayload(jobId: string): Promise<Record<string, unknown>> {
    const r = await db.storage.engine().query<{ payload: unknown }>(`SELECT payload FROM jobs WHERE id = $1`, [jobId]);
    const p = r.rows[0]!.payload;
    return (typeof p === "string" ? JSON.parse(p) : p) as Record<string, unknown>;
  }

  async function admitCapture(token: string, slug: string): Promise<string> {
    const auth = ingestAuth(await provider.verifyAccessToken(token));
    const res = await handleIngestRoute(
      new Request("http://test/ingest", { method: "POST", headers: { "content-type": "text/markdown", "x-memrain-slug": slug }, body: `capture ${slug}` }),
      { storage: db.storage, authInfo: auth, allowRequest: () => true, clientIp: "1.2.3.4" },
    );
    expect(res.status).toBe(202);
    return String(((await res.json()) as { job_id: string }).job_id);
  }

  async function runJob(kind: string, jobId: string): Promise<unknown> {
    const payload = await queuedPayload(jobId);
    try {
      return await getHandler(kind)!(payload, { job: { id: jobId } as JobRow });
    } catch (e) {
      return e;
    }
  }

  function expectRefused(outcome: unknown, reason: RegExp): void {
    expect(outcome).toBeInstanceOf(UnrecoverableJobError);
    expect((outcome as Error).message).toMatch(/^refused: /);
    expect((outcome as Error).message).toMatch(reason);
  }

  it("the job carries a principal reference, never the bearer", async () => {
    const pat = await mintPat();
    const jobId = await admitCapture(pat.token, `notes/ref-${unique()}`);
    const payload = await queuedPayload(jobId);
    expect(payload.principal).toMatchObject({ kind: "pat" });
    expect(JSON.stringify(payload)).not.toContain(pat.token);
  });

  it("writes when the PAT is unchanged", async () => {
    const pat = await mintPat();
    const slug = `notes/pat-ok-${unique()}`;
    const outcome = await runJob(INGEST_CAPTURE_JOB_KIND, await admitCapture(pat.token, slug));
    expect(outcome).not.toBeInstanceOf(Error);
    expect((await getPage(db.storage, slug))?.source_id).toBe("acme");
  });

  it("refuses when the PAT is revoked after admission, keeping the raw capture", async () => {
    const pat = await mintPat();
    const slug = `notes/pat-revoked-${unique()}`;
    const jobId = await admitCapture(pat.token, slug);
    await db.storage.engine().query(`UPDATE access_tokens SET revoked_at = now() WHERE name = $1`, [pat.name]);
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /revoked/);
    expect(await getPage(db.storage, slug)).toBeNull();
    expect(JSON.stringify(await queuedPayload(jobId))).toContain(`capture ${slug}`);
  });

  it("refuses when the PAT loses the write scope", async () => {
    const pat = await mintPat();
    const slug = `notes/pat-narrow-${unique()}`;
    const jobId = await admitCapture(pat.token, slug);
    await db.storage.engine().query(`UPDATE access_tokens SET scopes = ARRAY['read'] WHERE name = $1`, [pat.name]);
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /write scope/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses when the PAT's write source moved", async () => {
    const pat = await mintPat();
    const slug = `notes/pat-moved-${unique()}`;
    const jobId = await admitCapture(pat.token, slug);
    await db.storage.engine().query(
      `UPDATE access_tokens SET permissions = $2::text::jsonb WHERE name = $1`,
      [pat.name, JSON.stringify({ source_id: "beta" })],
    );
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /source/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("writes for an OAuth session whose access token only expired", async () => {
    const client = await webClient();
    const tokens = await signIn(client);
    const slug = `notes/oauth-expired-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await db.storage.engine().query(`UPDATE oauth_tokens SET expires_at = 1 WHERE token_hash = $1`, [sha(tokens.access_token)]);
    expect(await runJob(INGEST_CAPTURE_JOB_KIND, jobId)).not.toBeInstanceOf(Error);
    expect(await getPage(db.storage, slug)).not.toBeNull();
  });

  it("writes for an OAuth session after its refresh token rotated", async () => {
    const client = await webClient();
    const tokens = await signIn(client);
    const slug = `notes/oauth-rotated-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(await runJob(INGEST_CAPTURE_JOB_KIND, jobId)).not.toBeInstanceOf(Error);
    expect(await getPage(db.storage, slug)).not.toBeNull();
  });

  it("refuses when the OAuth session's refresh token is revoked", async () => {
    const client = await webClient();
    const tokens = await signIn(client);
    const slug = `notes/oauth-revoked-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /revoked/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses when the OAuth client is revoked", async () => {
    const client = await webClient();
    const tokens = await signIn(client);
    const slug = `notes/oauth-client-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await provider.revokeClient(client.client_id, { actor: "test", via: "cli" });
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /revoked|no longer exists/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses when the OAuth client is narrowed to read", async () => {
    const client = await webClient();
    const tokens = await signIn(client);
    const slug = `notes/oauth-narrow-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await provider.rescopeClient(client.client_id, { sourceId: "acme", scopes: ["read"] }, { actor: "test", via: "cli" });
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /write scope|revoked|no longer exists/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses when the OAuth client's slug prefixes no longer cover the slug", async () => {
    const client = await webClient(["notes"]);
    const tokens = await signIn(client);
    const slug = `notes/oauth-prefix-${unique()}`;
    const jobId = await admitCapture(tokens.access_token, slug);
    await db.storage.engine().query(`UPDATE oauth_clients SET bound_slug_prefixes = ARRAY['inbox'] WHERE client_id = $1`, [client.client_id]);
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /prefix/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses a revoked client-credentials token even while the client holds another live one", async () => {
    const m2m = await machineToken();
    const slug = `notes/m2m-${unique()}`;
    const jobId = await admitCapture(m2m.token, slug);
    const other = await provider.exchangeClientCredentials(m2m.clientId, m2m.secret);
    expect((await provider.verifyAccessToken(other.access_token)).clientId).toBe(m2m.clientId);
    await provider.revokeToken((await provider.getClient(m2m.clientId))!, { token: m2m.token });
    expectRefused(await runJob(INGEST_CAPTURE_JOB_KIND, jobId), /revoked/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  it("refuses a legacy capture job that names no principal", async () => {
    const pat = await mintPat();
    const slug = `notes/legacy-${unique()}`;
    const payload = await queuedPayload(await admitCapture(pat.token, slug));
    delete payload.principal;
    let outcome: unknown;
    try { outcome = await getHandler(INGEST_CAPTURE_JOB_KIND)!(payload, { job: {} as JobRow }); } catch (e) { outcome = e; }
    expectRefused(outcome, /principal/);
    expect(await getPage(db.storage, slug)).toBeNull();
  });

  describe("transcript push", () => {
    async function admitPush(token: string): Promise<string> {
      const auth = ingestAuth(await provider.verifyAccessToken(token));
      const res = await handleIngestRoute(
        new Request("http://test/ingest", { method: "POST", headers: { "content-type": TRANSCRIPT_CT }, body: claudeRaw }),
        { storage: db.storage, authInfo: auth, allowRequest: () => true, clientIp: "1.2.3.4" },
      );
      expect(res.status).toBe(202);
      return String(((await res.json()) as { job_id: string }).job_id);
    }
    const transcriptPages = async (sourceId: string) =>
      (await db.storage.engine().query(`SELECT slug FROM pages WHERE source_id = $1 AND slug LIKE 'transcripts/%'`, [sourceId])).rows;

    it("refuses when the pushing PAT is revoked, then a live one writes", async () => {
      const revoked = await mintPat("beta");
      const jobId = await admitPush(revoked.token);
      expect((await queuedPayload(jobId)).principal).toMatchObject({ kind: "pat" });
      await db.storage.engine().query(`UPDATE access_tokens SET revoked_at = now() WHERE name = $1`, [revoked.name]);
      expectRefused(await runJob(TRANSCRIPTS_INGEST_JOB_KIND, jobId), /revoked/);
      expect(await transcriptPages("beta")).toHaveLength(0);

      const live = await mintPat("beta");
      expect(await runJob(TRANSCRIPTS_INGEST_JOB_KIND, await admitPush(live.token))).not.toBeInstanceOf(Error);
      expect((await transcriptPages("beta")).length).toBeGreaterThan(0);
    });

    it("refuses a legacy push job that names no principal", async () => {
      const pat = await mintPat("beta");
      const payload = await queuedPayload(await admitPush(pat.token));
      delete payload.principal;
      let outcome: unknown;
      try { outcome = await getHandler(TRANSCRIPTS_INGEST_JOB_KIND)!(payload, { job: {} as JobRow }); } catch (e) { outcome = e; }
      expectRefused(outcome, /principal/);
    });
  });
});
