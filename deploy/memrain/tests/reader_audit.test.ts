import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { OAuthProvider } from "../src/core/oauth-provider.ts";
import { inspectPageReaders } from "../src/core/reader-audit.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) {
  describe(`reader audit (${engine.name})`, () => {
    let opened: Awaited<ReturnType<typeof engine.open>>;
    let provider: OAuthProvider;
    const tokens = new Map<string, string>();
    beforeAll(async () => {
      opened = await engine.open();
      const s = opened.storage;
      provider = new OAuthProvider({ engine: s.engine() });
      for (const id of ["a", "b"]) await registerSource(s.engine(), { id, kind: "other", pathPrefix: `tenant:${id}` });
      await putPage(s, { slug: "notes/private", type: "note", source_id: "a", markdown_body: "PRIVATE-PAGE-BODY" });
      await putPage(s, { slug: "life/diary/private", type: "diary", source_id: "a", markdown_body: "PRIVATE-DIARY-BODY" });
      await dispatchTool(s, { name: "page_put", arguments: { slug: "notes/quarantined", type: "note", markdown_body: "Checking your browser before accessing example.com. Cloudflare Ray ID: 8badf00d" } }, { authInfo: { token: "fixture", clientId: "fixture", scopes: ["read", "write"], sourceId: "a", allowedSources: ["a"], isPublic: false } });
      for (const [name, source, scopes] of [["pat-a", "a", ["read"]], ["pat-b", "b", ["read"]], ["pat-empty", "a", []]] as const) {
        const token = `fixture-${name}`;
        tokens.set(name, token);
        await s.engine().query("INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, $3, $4::text::jsonb)",
          [name, createHash("sha256").update(token).digest("hex"), scopes, JSON.stringify({ source_id: source })]);
      }
      const registered = await provider.registerClientManual("shared", ["authorization_code", "refresh_token"], "read", ["https://example.invalid/cb"], "default", undefined, undefined, undefined, "enrollment");
      const client = (await provider.getClient(registered.clientId))!;
      for (const source of ["a", "b"]) {
        const enrollment = await provider.issueEnrollment({ sourceId: source, clientId: registered.clientId, label: `member-${source}` });
        const grant = await provider.claimEnrollment(enrollment.code, registered.clientId);
        const { redirectUrl } = await provider.authorize(client, { redirectUri: "https://example.invalid/cb", codeChallenge: "fixture-challenge", scopes: ["read"] }, grant);
        const issued = await provider.exchangeAuthorizationCode(client, new URL(redirectUrl).searchParams.get("code")!, undefined, "https://example.invalid/cb");
        tokens.set(`member-${source}`, issued.access_token);
      }
      await provider.issueEnrollment({ sourceId: "a", clientId: registered.clientId, label: "invited" });
      await provider.registerClientManual("unused", ["authorization_code"], "read", [], "a");
    });
    afterAll(async () => { await opened?.close(); });

    it("matches real page_get for PATs and two tenants on one connector without touching reads", async () => {
      const s = opened.storage;
      const report = await inspectPageReaders(s, "notes/private");
      expect(JSON.stringify(report)).not.toContain("PRIVATE-PAGE-BODY");
      expect(JSON.stringify(report)).not.toContain("token_hash");
      expect((await s.engine().query("SELECT last_used_at FROM access_tokens WHERE last_used_at IS NOT NULL")).rows).toHaveLength(0);
      expect((await s.engine().query("SELECT last_retrieved_at FROM pages WHERE last_retrieved_at IS NOT NULL")).rows).toHaveLength(0);
      for (const [name, token] of tokens) {
        const authInfo = await provider.verifyAccessToken(token);
        const actual = await dispatchTool(s, { name: "page_get", arguments: { slug: "notes/private" } }, { authInfo: { ...authInfo, isPublic: false }, adminPanel: true });
        const row = report.readers.find(r => r.name === name)!;
        expect(row.verdict).toBe(actual.isError ? "denied" : "readable");
      }
      expect(report.readers.find(r => r.name === "member-b")?.rule).toBe("source_scope");
      expect(report.readers.find(r => r.name === "pat-empty")?.rule).toBe("insufficient_scope");
      expect(report.readers.find(r => r.name === "invited")?.rule).toBe("not_redeemed");
      expect(report.readers.find(r => r.name === "unused")?.rule).toBe("no_access_token");
    });

    it("reports diary denial and quarantine redaction through the same read path", async () => {
      const diary = await inspectPageReaders(opened.storage, "life/diary/private");
      expect(diary.readers.find(r => r.name === "pat-a")?.rule).toBe("diary_fence");
      const quarantined = await inspectPageReaders(opened.storage, "notes/quarantined");
      expect(quarantined.readers.find(r => r.name === "member-a")).toMatchObject({ verdict: "readable_redacted", rule: "quarantine_redaction" });
    });

    it("applies revocation and expiry without treating a refresh token as read access", async () => {
      const e = opened.storage.engine();
      await e.query("UPDATE access_tokens SET revoked_at = NOW() WHERE name = 'pat-a'");
      await e.query("UPDATE oauth_tokens SET expires_at = 1 WHERE token_hash = $1", [createHash("sha256").update(tokens.get("member-a")!).digest("hex")]);
      await e.query("UPDATE oauth_enrollments SET revoked_at = NOW() WHERE label = 'member-b'");
      const report = await inspectPageReaders(opened.storage, "notes/private");
      expect(report.readers.find(r => r.name === "pat-a")?.rule).toBe("token_invalid_or_revoked");
      expect(report.readers.find(r => r.name === "member-a")?.rule).toBe("token_expired");
      expect(report.readers.find(r => r.name === "member-b")?.rule).toBe("grant_revoked");
      expect(report.readers.find(r => r.name === "member-a")?.credentials).toBe(1);
    });
  });
}
