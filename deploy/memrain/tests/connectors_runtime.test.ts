/**
 * The connector runtime's account writes on both engines: a token refresh
 * that finishes after the account was disconnected cannot bring its
 * credential back, and a refused refresh never turns a revoked or paused
 * account back into one waiting for a reconnect.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, markNeedsReconnect, setAccountStatus, storeCredential } from "../src/core/connectors/accounts.ts";
import { vaultCredentialStore } from "../src/core/connectors/runtime.ts";

const kek = kekFromBytes(randomBytes(32));

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector runtime account writes (${name})`, () => {
  async function connected(db: Awaited<ReturnType<typeof open>>) {
    const e = db.storage.engine();
    await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
    const account = await createAccount(e, { sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "owner@example.test" });
    await storeCredential(e, kek, account, { access_token: "old-access-token-0000", refresh_token: "old-refresh-token-0000" },
      { scopes: ["mail.read"], expiresAt: new Date(Date.now() - 1000) });
    return { e, account };
  }

  it("keeps the scopes and replaces the tokens of a live account's credential", async () => {
    const db = await open();
    try {
      const { account } = await connected(db);
      const store = vaultCredentialStore(db.storage.engine(), kek);
      const expiresAt = new Date(Date.now() + 3_600_000);
      await store.write(account.id, { accessToken: "new-access-token-1111", refreshToken: "new-refresh-token-1111", expiresAt });
      expect(await store.read(account.id)).toEqual({ accessToken: "new-access-token-1111", refreshToken: "new-refresh-token-1111", expiresAt });
    } finally { await db.close(); }
  });

  it("does not recreate a credential that a disconnect removed while it was being renewed", async () => {
    const db = await open();
    try {
      const { e, account } = await connected(db);
      const store = vaultCredentialStore(e, kek);
      // What disconnectAccount leaves behind.
      await e.query(`DELETE FROM connector_credentials WHERE account_id = $1`, [account.id]);
      await setAccountStatus(e, account.id, "revoked");
      await expect(store.write(account.id, { accessToken: "late-access-token-2222", refreshToken: "late-refresh-token-2222", expiresAt: null })).rejects.toThrow();
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM connector_credentials`)).rows[0]!.n)).toBe(0);
    } finally { await db.close(); }
  });

  it("does not renew the credential of an account that is no longer active", async () => {
    const db = await open();
    try {
      const { e, account } = await connected(db);
      await setAccountStatus(e, account.id, "paused");
      const store = vaultCredentialStore(e, kek);
      await expect(store.write(account.id, { accessToken: "late-access-token-3333", refreshToken: null, expiresAt: null })).rejects.toThrow();
      expect((await store.read(account.id))?.accessToken).toBe("old-access-token-0000");
    } finally { await db.close(); }
  });

  it("parks only an active account as needs_reconnect", async () => {
    const db = await open();
    try {
      const { e, account } = await connected(db);
      await setAccountStatus(e, account.id, "revoked");
      expect(await markNeedsReconnect(e, account.id, "refused")).toBe(false);
      expect((await getAccount(e, account.id))?.status).toBe("revoked");
      await setAccountStatus(e, account.id, "active");
      expect(await markNeedsReconnect(e, account.id, "refused")).toBe(true);
      expect((await getAccount(e, account.id))?.status).toBe("needs_reconnect");
    } finally { await db.close(); }
  });
});
