/**
 * Admin routes for members, groups and grant profiles, driven through
 * handleAdminApi's real gates with the headers the admin SPA's fetch() sends
 * (a real Origin and Sec-Fetch-Site: same-origin). Writes from a foreign
 * origin, from `Origin: null`, without a session or during the post-enroll
 * cooldown are refused before any route runs.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { handleAdminApi, type AdminApiDeps } from "../src/http/admin-api.ts";
import type { Storage } from "../src/core/storage.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://brain.example.test";

function deps(storage: Storage, extra: Partial<AdminApiDeps> = {}): AdminApiDeps {
  return { storage, publicUrl: ORIGIN, requireAdmin: () => true, sessionCooldown: () => null, ...extra };
}

const browserHeaders = (origin: string) => ({ origin, "sec-fetch-site": "same-origin", "content-type": "application/json" });
const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { "sec-fetch-site": "same-origin" } });
const post = (path: string, body: unknown = {}, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: browserHeaders(origin), body: JSON.stringify(body) });

async function call(req: Request, d: AdminApiDeps): Promise<Response> {
  const res = await handleAdminApi(req, new URL(req.url), d);
  if (!res) throw new Error(`route not handled: ${req.method} ${req.url}`);
  return res;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`admin member routes (${name})`, () => {
  it("adds a member, binds a key, groups them, then disabling refuses the key", async () => {
    const db = await open();
    try {
      const s = db.storage;
      const d = deps(s);
      await registerSource(s.engine(), { id: "alice", kind: "other", pathPrefix: "tenant:alice" });
      await registerSource(s.engine(), { id: "sales", kind: "other", pathPrefix: "tenant:sales" });
      const token = "memrain_" + randomBytes(24).toString("hex");
      await s.engine().query(
        `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ('alice-laptop', $1, ARRAY['read'], $2::jsonb)`,
        [createHash("sha256").update(token).digest("hex"), { source_id: "alice" }],
      );

      const added = await call(post("/admin/api/members", { id: "alice", display_name: "Alice", email: "a@example.com" }), d);
      expect(added.status).toBe(201);
      expect((await call(post("/admin/api/members", { id: "alice" }), d)).status).toBe(409);
      expect((await call(post("/admin/api/members/alice/bind", { kind: "token", id: "alice-laptop" }), d)).status).toBe(200);
      expect((await call(post("/admin/api/groups", { id: "sales-team" }), d)).status).toBe(201);
      expect((await call(post("/admin/api/groups/sales-team/sources", { source_id: "sales" }), d)).status).toBe(200);
      const owner = await call(post("/admin/api/groups/sales-team/sources", { source_id: "default" }), d);
      expect(owner.status).toBe(409);
      expect(((await owner.json()) as { error: string }).error).toBe("owner_source");
      expect((await call(post("/admin/api/groups/sales-team/members", { member_id: "alice" }), d)).status).toBe(200);

      const provider = new OAuthProvider({ engine: s.engine() });
      expect((await provider.verifyAccessToken(token)).allowedSources).toEqual(["alice", "sales"]);

      const shown = (await (await call(get("/admin/api/members/alice"), d)).json()) as { member: { groups: string[] }; credentials: unknown[]; audit: Array<{ via: string; actor: string }> };
      expect(shown.member.groups).toEqual(["sales-team"]);
      expect(shown.credentials).toEqual([{ kind: "token", id: "alice-laptop" }]);
      expect(shown.audit[0]).toMatchObject({ via: "admin_api", actor: "admin" });

      expect((await call(post("/admin/api/members/alice/disable"), d)).status).toBe(200);
      await expect(provider.verifyAccessToken(token)).rejects.toThrow("member_disabled");
      expect((await call(post("/admin/api/members/alice/enable"), d)).status).toBe(200);

      // Unbinding names the member that holds the key.
      await call(post("/admin/api/members", { id: "bob" }), d);
      expect((await call(post("/admin/api/members/bob/unbind", { kind: "token", id: "alice-laptop" }), d)).status).toBe(404);
      expect((await call(post("/admin/api/members/alice/unbind", { kind: "token", id: "alice-laptop" }), d)).status).toBe(200);

      expect((await call(post("/admin/api/groups/sales-team/members/alice/remove"), d)).status).toBe(200);
      expect((await call(post("/admin/api/groups/sales-team/sources/sales/revoke"), d)).status).toBe(200);
      expect((await call(post("/admin/api/groups/sales-team/remove"), d)).status).toBe(200);
      expect((await call(get("/admin/api/groups/sales-team"), d)).status).toBe(404);
      expect((await call(post("/admin/api/members/alice/remove"), d)).status).toBe(200);
      expect((await call(post("/admin/api/members/alice/enable"), d)).status).toBe(409);

      const catalog = (await (await call(get("/admin/api/grant-profiles"), d)).json()) as { profiles: Array<{ id: string }> };
      expect(catalog.profiles.map((p) => p.id)).toContain("reader");
    } finally { await db.close(); }
  });

  it("refuses writes that do not come from the admin page itself", async () => {
    const db = await open();
    try {
      const s = db.storage;
      const refused = async (req: Request, d: AdminApiDeps, status: number) => {
        const res = await call(req, d);
        expect(res.status).toBe(status);
      };
      await refused(post("/admin/api/members", { id: "eve" }, "https://evil.example"), deps(s), 403);
      await refused(post("/admin/api/members", { id: "eve" }, "null"), deps(s), 403);
      await refused(post("/admin/api/members", { id: "eve" }), deps(s, { requireAdmin: () => false }), 401);
      await refused(post("/admin/api/members", { id: "eve" }), deps(s, { sessionCooldown: () => Date.now() + 60_000 }), 403);
      expect(((await (await call(get("/admin/api/members?all=1"), deps(s))).json()) as { members: unknown[] }).members).toEqual([]);
    } finally { await db.close(); }
  });
});
