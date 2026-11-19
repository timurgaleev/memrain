/**
 * Refresh-family revocation against a real Postgres, where two transactions do
 * run at once (PGLite serializes them, so it cannot show this race). Skipped
 * unless MEMRAIN_TEST_POSTGRES_URL points at a scratch database with pgvector.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { PostgresEngine } from "../src/core/engine/postgres.ts";
import { pgTestEngine } from "./helpers/pg-test-engine.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, REFRESH_REUSE_GRACE_SECONDS, type OAuthClientInfo } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;
const REDIRECT = "https://client.example/cb";
const sha = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

/**
 * An engine whose transactions stop before recording a consumed refresh token,
 * i.e. right after the rotating DELETE, until `release` is called.
 */
function gatedEngine(inner: Engine): { engine: Engine; reached: Promise<void>; release: () => void } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  const released = new Promise<void>((r) => (release = r));
  const engine: Engine = {
    kind: inner.kind,
    ready: () => inner.ready(),
    query: (sql, params) => inner.query(sql, params),
    exec: (sql) => inner.exec(sql),
    close: async () => {},
    transaction: (fn) =>
      inner.transaction((tx) =>
        fn({
          ...tx,
          query: async (sql, params) => {
            if (sql.includes("INSERT INTO oauth_refresh_consumed")) {
              reach();
              await released;
            }
            return tx.query(sql, params);
          },
        }),
      ),
  };
  return { engine, reached, release };
}

describe.skipIf(!URL_)("refresh family revocation on Postgres", () => {
  let pg: PostgresEngine;
  let provider: OAuthProvider;

  beforeAll(async () => {
    pg = pgTestEngine({ url: URL_! });
    await new Storage(pg).init();
    provider = new OAuthProvider({ engine: pg });
    await registerSource(pg, { id: "acme", kind: "other", pathPrefix: "/acme" }).catch(() => {});
  });

  afterAll(async () => {
    await pg.close();
  });

  async function webClient(): Promise<OAuthClientInfo> {
    const { clientId } = await provider.registerClientManual(
      "web",
      ["authorization_code", "refresh_token"],
      "read write",
      [REDIRECT],
      "acme",
      undefined,
      undefined,
      undefined,
      "client",
    );
    return (await provider.getClient(clientId))!;
  }

  it("a replay during an in-flight rotation revokes the tokens that rotation mints", async () => {
    const saved = process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
    process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = "1";
    try {
      const client = await webClient();
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const { redirectUrl } = await provider.authorize(client, { codeChallenge: challenge, redirectUri: REDIRECT });
      const code = new URL(redirectUrl).searchParams.get("code")!;
      const t0 = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
      const t1 = await provider.exchangeRefreshToken(client, t0.refresh_token!);
      await pg.query(
        "UPDATE oauth_refresh_consumed SET consumed_at = consumed_at - $2 WHERE token_hash = $1",
        [sha(t0.refresh_token!), REFRESH_REUSE_GRACE_SECONDS + 5],
      );
      const family = (
        await pg.query<{ family_id: string }>("SELECT family_id FROM oauth_tokens WHERE token_hash = $1", [
          sha(t1.refresh_token!),
        ])
      ).rows[0]!.family_id;

      const gate = gatedEngine(pg);
      const rotating = new OAuthProvider({ engine: gate.engine }).exchangeRefreshToken(client, t1.refresh_token!);
      await gate.reached;
      const replay = provider.exchangeRefreshToken(client, t0.refresh_token!).catch((e: Error) => e);
      await new Promise((r) => setTimeout(r, 300));
      gate.release();

      const t2 = await rotating;
      expect(t2.access_token).toMatch(/^memrain_at_/);
      expect(((await replay) as Error).message).toContain("session was revoked");
      const left = await pg.query<{ n: number | string }>(
        "SELECT count(*) AS n FROM oauth_tokens WHERE family_id = $1",
        [family],
      );
      expect(Number(left.rows[0]!.n)).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE;
      else process.env.MEMRAIN_OAUTH_REFRESH_REUSE_REVOKE = saved;
    }
  });
});
