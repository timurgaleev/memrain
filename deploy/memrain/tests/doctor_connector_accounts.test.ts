import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount, markNeedsReconnect, storeCredential } from "../src/core/connectors/accounts.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { checkConnectorAccounts } from "../src/core/connectors/doctor.ts";

const keyBytes = randomBytes(32);
const kek = kekFromBytes(keyBytes);
const ON = { MEMRAIN_CONNECTORS_ENABLED: "1", MEMRAIN_CONNECTOR_KEK: keyBytes.toString("base64") };

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`doctor connector-accounts (${name})`, () => {
  it("is ok and says why when connectors are off with no accounts", async () => {
    const db = await open();
    try {
      const r = await checkConnectorAccounts(db.storage.engine(), {});
      expect(r).toEqual({ ok: true, status: "ok", detail: expect.stringContaining("MEMRAIN_CONNECTORS_ENABLED") });
      const noKey = await checkConnectorAccounts(db.storage.engine(), { MEMRAIN_CONNECTORS_ENABLED: "1" });
      expect(noKey.status).toBe("warn");
      expect(noKey.detail).toContain("MEMRAIN_CONNECTOR_KEK");
    } finally { await db.close(); }
  });

  it("warns about accounts that cannot sync, by provider and id, never by token", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const acct = await createAccount(e, { sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "a@example.test" });
      await storeCredential(e, kek, acct, { access_token: "doctor-live-token" }, { scopes: ["read"], expiresAt: null });
      expect(await checkConnectorAccounts(e, ON)).toEqual({ ok: true, status: "ok", detail: "1 connector account(s), all active" });

      const off = await checkConnectorAccounts(e, {});
      expect(off.status).toBe("warn");
      expect(off.detail).toContain("1 connector account(s) cannot sync");

      await markNeedsReconnect(e, acct.id, "invalid_grant");
      const parked = await checkConnectorAccounts(e, ON);
      expect(parked.status).toBe("warn");
      expect(parked.detail).toContain(`test/${acct.id.slice(0, 8)}: needs_reconnect (invalid_grant)`);
      expect(parked.detail).not.toContain("doctor-live-token");
      expect(parked.detail).not.toContain("a@example.test");

      const otherKey = { ...ON, MEMRAIN_CONNECTOR_KEK: randomBytes(32).toString("base64") };
      const mismatch = await checkConnectorAccounts(e, otherKey);
      expect(mismatch.detail).toContain("1 credential(s) sealed by another key");
    } finally { await db.close(); }
  });
});
