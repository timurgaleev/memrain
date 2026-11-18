/**
 * Gates 1 and 2: two tenants provisioned on one server are separate brains.
 *   1. The same slug in both is independent: writing, editing and deleting it
 *      in A leaves B's body, version, chunks and facts as they were.
 *   2. A's credentials mean nothing on B's server: A's personal access token,
 *      A's OAuth token and A's enrollment code are refused, even after B holds
 *      a client with the same client_id as A's connector.
 * Skipped unless MEMRAIN_TEST_POSTGRES_URL points at a scratch Postgres.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { Storage } from "../src/core/storage.ts";
import { deletePage, putPage } from "../src/core/pages.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { startServer, type ServerHandle } from "../src/http/server.ts";
import { PG_URL } from "./helpers/control-pg.ts";
import { openControlFixture, type ControlFixture } from "./helpers/control-tenants.ts";

setDefaultTimeout(180_000);

const CB = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe.skipIf(!PG_URL)("two tenants on one server", () => {
  let fx: ControlFixture;
  let a: string;
  let b: string;
  let sa: Storage;
  let sb: Storage;

  beforeAll(async () => {
    fx = await openControlFixture(PG_URL!);
    a = fx.tenantId("silo-a");
    b = fx.tenantId("silo-b");
    await fx.create(a);
    await fx.create(b);
    sa = new Storage(new PostgresEngine({ url: fx.secret(a, "postgres-url"), max: 2 }));
    sb = new Storage(new PostgresEngine({ url: fx.secret(b, "postgres-url"), max: 2 }));
    await sa.init();
    await sb.init();
  });
  afterAll(async () => {
    await sa.close();
    await sb.close();
    await fx.close();
  });

  async function snapshot(s: Storage, slug: string) {
    const page = await s.engine().query<{ hash: string; generation: number; deleted: boolean }>(
      `SELECT content_hash AS hash, generation, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug = $1`,
      [slug],
    );
    const counts = await s.engine().query<{ chunks: number; facts: number; versions: number }>(
      `SELECT (SELECT count(*)::int FROM chunks) AS chunks,
              (SELECT count(*)::int FROM entity_facts) AS facts,
              (SELECT count(*)::int FROM page_versions WHERE slug = $1) AS versions`,
      [slug],
    );
    return { page: page.rows, ...counts.rows[0]! };
  }

  it("gate 1: the same slug in two tenants is independent", async () => {
    await putPage(sa, { slug: "people/alice", markdown_body: "Alice from tenant A.", source_id: "default", title: "Alice" });
    await putPage(sb, { slug: "people/alice", markdown_body: "Alice from tenant B.", source_id: "default", title: "Alice" });
    const before = await snapshot(sb, "people/alice");
    expect(before.page).toHaveLength(1);

    await putPage(sa, { slug: "people/alice", markdown_body: "Alice from tenant A, edited.", source_id: "default", title: "Alice" });
    await deletePage(sa, "people/alice");
    expect((await snapshot(sa, "people/alice")).page[0]!.deleted).toBe(true);

    expect(await snapshot(sb, "people/alice")).toEqual(before);
  });

  describe("gate 2: A's credentials on B's server", () => {
    let server: ServerHandle;
    let base: string;
    const pa = () => new OAuthProvider({ engine: sa.engine() });
    const pb = () => new OAuthProvider({ engine: sb.engine() });

    async function mintPat(s: Storage, name: string): Promise<string> {
      const token = "memrain_" + randomBytes(24).toString("hex");
      const hash = createHash("sha256").update(token).digest("hex");
      await s.engine().query(
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, ARRAY['read','write'], '{}'::jsonb)`,
        [name, hash],
      );
      return token;
    }

    async function connectorOf(id: string): Promise<string> {
      const r = await fx.control.query<{ c: string }>(`SELECT connector_client_id AS c FROM tenants WHERE id = $1`, [id]);
      return r.rows[0]!.c;
    }

    beforeAll(() => {
      server = startServer({ host: "127.0.0.1", port: 0, storage: sb, publicBearerToken: "pub-bearer-silo-test", oauthProvider: pb() });
      base = `http://127.0.0.1:${server.port}`;
    });
    afterAll(async () => {
      await server.stop();
    });

    const listTools = (bearer: string) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${bearer}`,
        "Cf-Connecting-Ip": "203.0.113.9",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    it("B's own token works and A's is refused with 401", async () => {
      expect((await listTools(await mintPat(sb, "b-laptop"))).status).toBe(200);
      expect((await listTools(await mintPat(sa, "a-laptop"))).status).toBe(401);
    });

    it("A's OAuth token and enrollment code are refused on B, even with A's client_id present there", async () => {
      const clientId = await connectorOf(a);
      const provider = pa();
      const client = (await provider.getClient(clientId))!;
      const issued = await provider.issueEnrollment({ sourceId: "person-owner", label: "owner laptop" });
      const grant = await provider.claimEnrollment(issued.code, clientId);
      const { redirectUrl } = await provider.authorize(client, { redirectUri: CB, codeChallenge: CHALLENGE, scopes: ["read", "write"] }, grant);
      const code = new URL(redirectUrl).searchParams.get("code")!;
      const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, CB);
      expect((await provider.verifyAccessToken(tokens.access_token)).clientId).toBe(clientId);
      expect((await listTools(tokens.access_token)).status).toBe(401);

      // B gets a client with exactly A's client_id; A's token still means nothing there.
      await sb.engine().query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, source_id, federated_read, tenant_mode)
         VALUES ($1, 'lookalike', ARRAY[$2], ARRAY['authorization_code','refresh_token'], 'read write', 'none',
                 extract(epoch FROM now())::bigint, 'default', ARRAY['default'], 'enrollment')`,
        [clientId, CB],
      );
      expect((await listTools(tokens.access_token)).status).toBe(401);
      const second = await provider.issueEnrollment({ sourceId: "person-owner", label: "second device" });
      expect(await pb().claimEnrollment(second.code, clientId)).toBeUndefined();
    });
  });
});
