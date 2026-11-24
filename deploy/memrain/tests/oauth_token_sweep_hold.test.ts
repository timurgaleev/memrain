/**
 * The OAuth token sweep keeps an expired token that a pending or running
 * ingest job a pre-Lite build queued still names: a build that runs jobs re-reads
 * those rows when it resumes the job, and reaching the TTL is not a
 * revocation. This build never runs the jobs; it only must not orphan them.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`token sweep job hold (${name})`, () => {
    let db: Awaited<ReturnType<typeof open>>;
    beforeEach(async () => {
      db = await open();
      await db.storage.raw().query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, client_id_issued_at)
         VALUES ('sweep-app', 'sweep', '{}', '{client_credentials}', 'read', 'client_secret_post', 0)`,
      );
    });
    afterEach(async () => { await db.close(); });

    const token = (hash: string, family: string | null) => db.storage.engine().query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, family_id)
       VALUES ($1, 'access', 'sweep-app', ARRAY['read'], 1, $2)`,
      [hash, family],
    );
    const job = (id: string, kind: string, status: string, principal: Record<string, string>) => db.storage.engine().query(
      `INSERT INTO jobs (id, kind, status, payload) VALUES ($1, $2, $3, $4::text::jsonb)`,
      [id, kind, status, JSON.stringify({ principal })],
    );
    const left = async () =>
      (await db.storage.engine().query<{ token_hash: string }>(`SELECT token_hash FROM oauth_tokens ORDER BY token_hash`)).rows.map(r => r.token_hash);
    const sweep = () => new OAuthProvider({ engine: db.storage.engine() }).sweepExpiredTokens();

    // Value: protects=a queued pre-Lite capture or push can still resolve its principal after the
    // upgrade; fails_when=the sweep drops a token or family a live job names; why_new=the hold was
    // removed with the job queue; seam=jobs rows as pre-Lite builds wrote them
    it("keeps a family-less token and a whole family that live ingest jobs name", async () => {
      await token("tok-capture", null);
      await token("fam-access", "fam-1");
      await token("fam-refresh", "fam-1");
      await job("j1", "ingest_capture", "pending", { kind: "oauth_token", id: "tok-capture" });
      await job("j2", "transcripts_ingest", "running", { kind: "oauth_family", id: "fam-1" });
      expect(await sweep()).toBe(0);
      expect(await left()).toEqual(["fam-access", "fam-refresh", "tok-capture"]);
    });

    // Value: protects=the hold ends with the job; fails_when=a finished job, another job kind or an
    // unnamed token keeps an expired token forever; why_new=same; seam=same
    it("sweeps tokens no live ingest job names", async () => {
      await token("tok-done", null);
      await token("tok-other-kind", null);
      await token("tok-loose", null);
      await job("j3", "ingest_capture", "succeeded", { kind: "oauth_token", id: "tok-done" });
      await job("j4", "embed", "pending", { kind: "oauth_token", id: "tok-other-kind" });
      expect(await sweep()).toBe(3);
      expect(await left()).toEqual([]);
    });

    // Value: protects=the hold is per row kind; fails_when=a family id held as a token, or a token in a
    // family held by its hash, survives; why_new=same; seam=same
    it("matches a token hold only to family-less rows and a family hold only to its family", async () => {
      await token("in-family", "fam-2");
      await job("j5", "ingest_capture", "pending", { kind: "oauth_token", id: "in-family" });
      await job("j6", "ingest_capture", "pending", { kind: "oauth_token", id: "fam-3" });
      await token("fam-3-row", "fam-3");
      expect(await sweep()).toBe(2);
      expect(await left()).toEqual([]);
    });
  });
}
