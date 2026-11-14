import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { deleteSource, registerSource, sourceReferences } from "../src/core/sources.ts";
import { kekFromBytes, oauthStateAad, seal, VaultError } from "../src/core/connectors/vault.ts";
import {
  createAccount,
  credentialMeta,
  deleteAccount,
  getAccount,
  listAccounts,
  markNeedsReconnect,
  readCredential,
  setAccountEnabled,
  storeCredential,
} from "../src/core/connectors/accounts.ts";
import { deleteOAuthClient, getOAuthClient, listOAuthClients, setOAuthClient } from "../src/core/connectors/oauth-clients.ts";
import { rotateKek } from "../src/core/connectors/vault-rotate.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const kek = kekFromBytes(randomBytes(32));
const next = kekFromBytes(randomBytes(32));
const TOKENS = { access_token: "ya29.live-access-token", refresh_token: "1//live-refresh-token", token_type: "Bearer" };

async function vaultCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof VaultError ? e.code : `other: ${String(e)}`;
  }
}

async function setup(e: Engine) {
  await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
  return createAccount(e, {
    sourceId: "inbox",
    provider: "test",
    services: ["mail"],
    principalRef: "admin:operator",
    accountLabel: "someone@example.test",
  });
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector accounts (${name})`, () => {
  it("creates an account disabled, active, and never exposes ciphertext", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const acct = await setup(e);
      expect(acct.enabled).toBe(false);
      expect(acct.status).toBe("active");
      await storeCredential(e, kek, acct, TOKENS, { scopes: ["read"], expiresAt: new Date("2030-01-01T00:00:00Z") });
      const listed = await listAccounts(e, { sourceId: "inbox" });
      expect(listed.map((a) => a.id)).toEqual([acct.id]);
      expect(JSON.stringify(listed)).not.toContain("ciphertext");
      expect(JSON.stringify(listed)).not.toContain("live-access");
      const meta = await credentialMeta(e, acct.id);
      expect(meta).toMatchObject({ kek_id: kek.id, scopes: ["read"] });
      expect(JSON.stringify(meta)).not.toContain("live");
    } finally { await db.close(); }
  });

  it("rejects a malformed provider, service or label", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const base = { sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "a@example.test" };
      await expect(createAccount(e, { ...base, provider: "Bad Provider" })).rejects.toThrow("provider");
      await expect(createAccount(e, { ...base, services: ["mail; drop"] })).rejects.toThrow("service");
      await expect(createAccount(e, { ...base, accountLabel: "a\nb" })).rejects.toThrow("label");
      await expect(createAccount(e, { ...base, accountLabel: "   " })).rejects.toThrow("label");
    } finally { await db.close(); }
  });

  it("stores tokens only as ciphertext and reads them back under the right key", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const acct = await setup(e);
      await storeCredential(e, kek, acct, TOKENS, { scopes: ["read"], expiresAt: null });
      const raw = await e.query<Record<string, unknown>>(`SELECT * FROM connector_credentials`);
      expect(JSON.stringify(raw.rows)).not.toContain("live-access");
      expect(JSON.stringify(raw.rows)).not.toContain("live-refresh");
      const echo = new Map<string, string>();
      const cred = await readCredential(e, kek, acct.id, { echo });
      expect(cred?.tokens).toEqual(TOKENS);
      expect([...echo.keys()].sort()).toEqual([TOKENS.access_token, TOKENS.refresh_token].sort());
      expect(await vaultCode(readCredential(e, next, acct.id))).toBe("vault_wrong_key");
    } finally { await db.close(); }
  });

  it("refuses a credential row copied onto another account", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const victim = await setup(e);
      const attacker = await createAccount(e, {
        sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "attacker@example.test",
      });
      await storeCredential(e, kek, victim, TOKENS, { scopes: ["read"], expiresAt: null });
      await e.query(
        `INSERT INTO connector_credentials (account_id, kek_id, nonce, ciphertext, scopes)
         SELECT $1, kek_id, nonce, ciphertext, scopes FROM connector_credentials WHERE account_id = $2`,
        [attacker.id, victim.id]);
      expect(await vaultCode(readCredential(e, kek, attacker.id))).toBe("vault_tamper");
    } finally { await db.close(); }
  });

  it("parks an account as needs_reconnect without touching its data or settings", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const acct = await setup(e);
      await setAccountEnabled(e, acct.id, true);
      await storeCredential(e, kek, acct, TOKENS, { scopes: ["read"], expiresAt: null });
      await markNeedsReconnect(e, acct.id, "invalid_grant");
      const after = await getAccount(e, acct.id);
      expect(after).toMatchObject({ status: "needs_reconnect", status_reason: "invalid_grant", enabled: true });
      expect(await credentialMeta(e, acct.id)).not.toBeNull();
    } finally { await db.close(); }
  });

  it("names connector accounts among a source's references and keeps the source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const acct = await setup(e);
      expect(await sourceReferences(e, "inbox")).toEqual({ connector_accounts: 1 });
      expect(await deleteSource(e, "inbox")).toBe(false);
      await deleteAccount(e, acct.id);
      expect(await credentialMeta(e, acct.id)).toBeNull();
      expect(await deleteSource(e, "inbox")).toBe(true);
    } finally { await db.close(); }
  });

  it("keeps a bring-your-own OAuth client secret sealed", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await setOAuthClient(e, kek, "test", "client-123.apps.example", "byo-client-secret-value");
      const raw = await e.query<Record<string, unknown>>(`SELECT * FROM connector_oauth_clients`);
      expect(JSON.stringify(raw.rows)).not.toContain("byo-client-secret-value");
      expect(await getOAuthClient(e, kek, "test")).toEqual({ clientId: "client-123.apps.example", clientSecret: "byo-client-secret-value" });
      const listed = await listOAuthClients(e);
      expect(listed).toEqual([expect.objectContaining({ provider: "test", client_id: "client-123.apps.example", kek_id: kek.id })]);
      expect(JSON.stringify(listed)).not.toContain("byo-client-secret-value");
      await setOAuthClient(e, kek, "test", "client-456.apps.example", "rotated-secret-value");
      expect(await getOAuthClient(e, kek, "test")).toEqual({ clientId: "client-456.apps.example", clientSecret: "rotated-secret-value" });
      expect(await deleteOAuthClient(e, "test")).toBe(true);
      expect(await getOAuthClient(e, kek, "test")).toBeNull();
      await expect(setOAuthClient(e, kek, "test", "has space", "s")).rejects.toThrow("client id");
    } finally { await db.close(); }
  });

  it("rotates every sealed row to the new key in one transaction", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const acct = await setup(e);
      await storeCredential(e, kek, acct, TOKENS, { scopes: ["read"], expiresAt: null });
      await setOAuthClient(e, kek, "test", "client-123", "byo-secret");
      const stateHash = "a".repeat(64);
      const sealedVerifier = seal(kek, "verifier-value", oauthStateAad(stateHash, "test", kek.id));
      await e.query(
        `INSERT INTO connector_oauth_states (state_hash, provider, source_id, principal_ref, admin_session_hash,
           kek_id, nonce, pkce_verifier_enc, requested_scopes, redirect_uri, expires_at)
         VALUES ($1, 'test', 'inbox', 'admin:operator', 's', $2, $3, $4, ARRAY['read'], 'https://x.test/cb', NOW() + interval '5 minutes')`,
        [stateHash, sealedVerifier.kek_id, sealedVerifier.nonce, sealedVerifier.ciphertext]);

      const result = await rotateKek(e, kek, next);
      expect(result).toEqual({ credentials: 1, oauthClients: 1, oauthStates: 1 });
      expect(await vaultCode(readCredential(e, kek, acct.id))).toBe("vault_wrong_key");
      expect((await readCredential(e, next, acct.id))?.tokens).toEqual(TOKENS);
      expect(await getOAuthClient(e, next, "test")).toEqual({ clientId: "client-123", clientSecret: "byo-secret" });
      const states = await e.query<{ kek_id: string }>(`SELECT kek_id FROM connector_oauth_states`);
      expect(states.rows.map((r) => r.kek_id)).toEqual([next.id]);
      expect(await rotateKek(e, kek, next)).toEqual({ credentials: 0, oauthClients: 0, oauthStates: 0 });
    } finally { await db.close(); }
  });

  it("leaves every row on the old key when a rotation is interrupted", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const first = await setup(e);
      const second = await createAccount(e, {
        sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "second@example.test",
      });
      await storeCredential(e, kek, first, TOKENS, { scopes: ["read"], expiresAt: null });
      await storeCredential(e, kek, second, TOKENS, { scopes: ["read"], expiresAt: null });
      await setOAuthClient(e, kek, "test", "client-123", "byo-secret");
      // The second account's row is damaged, so rotation fails part-way.
      await e.query(`UPDATE connector_credentials SET ciphertext = $1 WHERE account_id = $2`,
        [Buffer.from("x".repeat(40)).toString("base64"), second.id]);

      expect(await vaultCode(rotateKek(e, kek, next))).toBe("vault_tamper");
      const ids = await e.query<{ kek_id: string }>(
        `SELECT kek_id FROM connector_credentials UNION ALL SELECT kek_id FROM connector_oauth_clients`);
      expect(new Set(ids.rows.map((r) => r.kek_id))).toEqual(new Set([kek.id]));
      expect((await readCredential(e, kek, first.id))?.tokens).toEqual(TOKENS);
      expect(await getOAuthClient(e, kek, "test")).toEqual({ clientId: "client-123", clientSecret: "byo-secret" });
    } finally { await db.close(); }
  });
});
