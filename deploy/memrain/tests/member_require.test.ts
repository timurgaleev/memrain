/**
 * MEMRAIN_REQUIRE_MEMBER=1: the verifier refuses a PAT or OAuth token bound
 * to no member. A bound credential still has to be bound to the brain's
 * enabled owner, so with the flag on only owner-bound credentials work. Off,
 * an unbound credential verifies exactly as before.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { InvalidTokenError, OAuthProvider } from "../src/core/oauth-provider.ts";

const saved = process.env["MEMRAIN_REQUIRE_MEMBER"];
afterEach(() => {
  if (saved === undefined) delete process.env["MEMRAIN_REQUIRE_MEMBER"];
  else process.env["MEMRAIN_REQUIRE_MEMBER"] = saved;
});

const UNBOUND = `memrain_${"c3".repeat(32)}`;
const BOUND = `memrain_${"d4".repeat(32)}`;
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`MEMRAIN_REQUIRE_MEMBER (${name})`, () => {
  it("refuses a credential bound to no member only while the flag is on", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await e.exec(`INSERT INTO members (id, status) VALUES ('alice', 'enabled'); INSERT INTO config (key, value) VALUES ('access.owner_member', 'alice');`);
      await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('ci', $1, ARRAY['read'])`, [hash(UNBOUND)]);
      await e.query(`INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ('alice-laptop', $1, ARRAY['read'], 'alice')`, [hash(BOUND)]);
      const p = new OAuthProvider({ engine: e });
      const client = await p.registerClientManual("svc", ["client_credentials"], "read");
      const oauth = (await p.exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;

      delete process.env["MEMRAIN_REQUIRE_MEMBER"];
      expect((await p.verifyAccessToken(UNBOUND)).clientId).toBe("ci");
      expect((await p.verifyAccessToken(oauth)).clientId).toBe(client.clientId);

      process.env["MEMRAIN_REQUIRE_MEMBER"] = "1";
      await expect(p.verifyAccessToken(UNBOUND)).rejects.toBeInstanceOf(InvalidTokenError);
      await expect(p.verifyAccessToken(oauth)).rejects.toBeInstanceOf(InvalidTokenError);
      expect((await p.verifyAccessToken(BOUND)).clientId).toBe("alice-laptop");
      await expect(p.verifyAccessToken(UNBOUND)).rejects.toThrow(/bound to its owner/);
    } finally {
      await db.close();
    }
  });
});
