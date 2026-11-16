/**
 * OAuth apps their provider refused (client-holds.ts), on both engines: a
 * refusal holds the provider's syncs for an hour, only for the app that was
 * refused, a later refusal extends the hold without restarting the episode,
 * and the owner has one notification per provider however many accounts
 * renew with the app.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";
import { CLIENT_HOLD_MS, clearClientHold, clientHeld, listClientHolds, recordClientRejection } from "../src/core/connectors/client-holds.ts";
import { OAuthClientRejectedError } from "../src/core/connectors/types.ts";
import { currentProblems } from "../src/core/notifications/store.ts";

const T0 = new Date("2026-11-16T10:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector client holds (${name})`, () => {
  it("holds the refused app's syncs for an hour, extends the hold on another refusal, and ends it when cleared", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await recordClientRejection(e, { provider: "microsoft", clientId: "app-a", error: new OAuthClientRejectedError("invalid_client", 7000222), now: T0 });
      expect(await clientHeld(e, "microsoft", "app-a", at(CLIENT_HOLD_MS - 60_000))).toBe(true);
      expect(await clientHeld(e, "microsoft", "app-a", at(CLIENT_HOLD_MS + 60_000))).toBe(false);
      // Another app, or no app, is not the refused one: it is tried at once.
      expect(await clientHeld(e, "microsoft", "app-b", at(60_000))).toBe(false);
      expect(await clientHeld(e, "microsoft", null, at(60_000))).toBe(false);
      expect(await clientHeld(e, "google", "app-a", at(60_000))).toBe(false);

      await recordClientRejection(e, { provider: "microsoft", clientId: "app-a", error: new OAuthClientRejectedError("invalid_client", 7000215), now: at(CLIENT_HOLD_MS + 60_000) });
      expect(await clientHeld(e, "microsoft", "app-a", at(2 * CLIENT_HOLD_MS))).toBe(true);
      expect(await listClientHolds(e)).toEqual([{
        provider: "microsoft", client_id: "app-a", reason: "invalid_client", service_code: 7000215,
        since: T0.toISOString(), refused_at: at(CLIENT_HOLD_MS + 60_000).toISOString(), held_until: at(2 * CLIENT_HOLD_MS + 60_000).toISOString(),
      }]);

      expect(await clearClientHold(e, "microsoft")).toBe(true);
      expect(await clearClientHold(e, "microsoft")).toBe(false);
      expect(await clientHeld(e, "microsoft", "app-a", at(2 * CLIENT_HOLD_MS))).toBe(false);
    } finally { await db.close(); }
  });

  it("is one problem per provider for the owner, however many accounts renew with the app", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "mail/" });
      for (const label of ["one@example.test", "two@example.test"]) {
        await createAccount(e, { sourceId: "inbox", provider: "google", services: ["gmail"], principalRef: "admin:operator", accountLabel: label });
      }
      await recordClientRejection(e, { provider: "google", clientId: "app-g", error: new OAuthClientRejectedError("invalid_client"), now: T0 });
      expect((await currentProblems(e)).filter(p => p.kind === "oauth_client_rejected"))
        .toEqual([{ kind: "oauth_client_rejected", ref: "google", source_id: "default" }]);
      // The hold running out does not resolve it: only a renewal that works, or a saved app, does.
      expect((await currentProblems(e)).some(p => p.kind === "oauth_client_rejected")).toBe(true);
      await clearClientHold(e, "google");
      expect((await currentProblems(e)).some(p => p.kind === "oauth_client_rejected")).toBe(false);
    } finally { await db.close(); }
  });
});
