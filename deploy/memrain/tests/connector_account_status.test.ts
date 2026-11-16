/**
 * Connector account status, as `connectors status`, doctor connector-health
 * and the Connections page read it: each account's state, last clean sync,
 * last run outcome and whether it waits on a reconnect, plus the grant-expiry
 * reading for a provider whose test-mode grants run out (Google: 7 days after
 * consent while the OAuth app is in Testing).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { runConnectors } from "../src/commands/connectors.ts";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import {
  createAccount,
  credentialMeta,
  deleteAccount,
  markAccountSynced,
  markNeedsReconnect,
  setAccountEnabled,
  storeCredential,
} from "../src/core/connectors/accounts.ts";
import {
  grantExpiry,
  listAccountStatus,
  readAccountRun,
  recordAccountRun,
} from "../src/core/connectors/account-status.ts";
import { openNotice } from "../src/core/connectors/sync-store.ts";
import { checkConnectorHealth } from "../src/core/connectors/health.ts";
import { builtinProviders } from "../src/core/connectors/providers.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import type { SyncRunResult } from "../src/core/connectors/sync-engine.ts";
import type { Engine } from "../src/core/engine/interface.ts";

const kek = kekFromBytes(randomBytes(32));
const DAY = 86_400_000;
const HOUR = 3_600_000;
const G = Date.parse("2026-11-09T10:00:00Z");

function result(over: Partial<SyncRunResult> = {}): SyncRunResult {
  return {
    account_id: "x",
    source_id: "cal",
    status: "success",
    stop_reason: null,
    counts: {
      items: 12, pages_written: 3, pages_unchanged: 9, duplicates: 0, items_failed: 0, items_held: 0, items_skipped_held: 0,
      deletions_seen: 0, deletions_applied: 0, deletions_held: 0, retention_deleted: 0, mirror_failures: 0,
    },
    streams: [],
    error_class: null,
    http_status: null,
    error: null,
    ...over,
  };
}

describe("grantExpiry", () => {
  const active = { provider: "google", status: "active" as const, last_success_at: null, reconnect_since: null };

  it("reads nothing for a provider without a test-mode limit or a grant time", () => {
    expect(grantExpiry({ ...active, provider: "fireflies" }, new Date(G).toISOString(), G + DAY)).toBeNull();
    expect(grantExpiry(active, null, G + DAY)).toBeNull();
  });

  it("names the expected end of a fresh Google grant, and warns from day five", () => {
    const fresh = grantExpiry(active, new Date(G).toISOString(), G + DAY)!;
    expect(fresh).toEqual({
      granted_at: "2026-11-09T10:00:00.000Z", expires_at: "2026-11-16T10:00:00.000Z", days: 7, state: "upcoming", due_soon: false,
    });
    expect(grantExpiry(active, new Date(G).toISOString(), G + 5 * DAY)!.due_soon).toBe(true);
  });

  it("stops warning once a sync succeeded well after the limit: the app is not in Testing", () => {
    const survived = { ...active, last_success_at: new Date(G + 8 * DAY).toISOString() };
    expect(grantExpiry(survived, new Date(G).toISOString(), G + 8 * DAY + HOUR)).toBeNull();
    // A day past the limit with no proof either way, it says nothing rather than guess.
    expect(grantExpiry(active, new Date(G).toISOString(), G + 9 * DAY)).toBeNull();
  });

  it("names the test-mode limit as the likely cause of a reconnect six or more days after consent", () => {
    const parked = { ...active, status: "needs_reconnect" as const, reconnect_since: new Date(G + 7 * DAY + HOUR).toISOString() };
    expect(grantExpiry(parked, new Date(G).toISOString(), G + 8 * DAY)).toMatchObject({ state: "lapsed", expires_at: "2026-11-16T10:00:00.000Z" });
    // Refused on day two: something else (a revoke) ended it.
    expect(grantExpiry({ ...parked, reconnect_since: new Date(G + 2 * DAY).toISOString() }, new Date(G).toISOString(), G + 3 * DAY)).toBeNull();
    // A clean sync after the limit proves the grant outlived it, so the limit is not the cause.
    expect(grantExpiry({ ...parked, last_success_at: new Date(G + 10 * DAY).toISOString(), reconnect_since: new Date(G + 30 * DAY).toISOString() },
      new Date(G).toISOString(), G + 31 * DAY)).toBeNull();
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`connector account status (${name})`, () => {
  async function seedAccount(e: Engine, label = "owner@example.test", provider = "google") {
    await registerSource(e, { id: "cal", kind: "calendar", pathPrefix: "calendar/" }).catch(() => undefined);
    const a = await createAccount(e, { sourceId: "cal", provider, services: ["calendar"], principalRef: "admin:operator", accountLabel: label });
    await storeCredential(e, kek, a, { access_token: "at-1", refresh_token: "rt-1" }, { scopes: ["calendar.readonly"], expiresAt: null });
    return a;
  }

  it("records the last run of an account without a token or an address, and forgets it with the account", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const a = await seedAccount(e);
      await recordAccountRun(e, a.id, result({ status: "partial", stop_reason: "fetch_failed", error: "calendar list failed: rate_limited", http_status: 429 }), new Date(G));
      expect(await readAccountRun(e, a.id)).toEqual({
        status: "partial", stop_reason: "fetch_failed", at: "2026-11-09T10:00:00.000Z", http_status: 429,
        error: "calendar list failed: rate_limited", items: 12, pages_written: 3, items_failed: 0,
      });
      expect(await deleteAccount(e, a.id)).toBe(true);
      expect(await readAccountRun(e, a.id)).toBeNull();
    } finally { await db.close(); }
  });

  it("dates a grant from its last consent: a reconnect restarts the clock, a token refresh does not", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const a = await seedAccount(e);
      const first = (await credentialMeta(e, a.id))!.granted_at;
      await e.query(`UPDATE connector_credentials SET created_at = NOW() - INTERVAL '3 days' WHERE account_id = $1`, [a.id]);
      const backdated = (await credentialMeta(e, a.id))!.granted_at;
      expect(Date.parse(backdated)).toBeLessThan(Date.parse(first));
      await storeCredential(e, kek, a, { access_token: "at-2", refresh_token: "rt-2" }, { scopes: ["calendar.readonly"], expiresAt: null });
      expect(Date.parse((await credentialMeta(e, a.id))!.granted_at)).toBeGreaterThan(Date.parse(backdated));
    } finally { await db.close(); }
  });

  it("lists every account with its state, last clean sync, last run and whether it waits on a reconnect", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const syncing = await seedAccount(e, "owner@example.test");
      const parked = await seedAccount(e, "other@example.test");
      await setAccountEnabled(e, syncing.id, true);
      await markAccountSynced(e, syncing.id);
      await recordAccountRun(e, syncing.id, result(), new Date());
      await setAccountEnabled(e, parked.id, true);
      await markNeedsReconnect(e, parked.id, "invalid_grant");
      await openNotice(e, parked.id, "needs_reconnect", "google account for source 'cal' needs a reconnect");

      const rows = await listAccountStatus(e);
      expect(rows.map((r) => [r.account_label, r.state, r.enabled, r.needs_reconnect])).toEqual([
        ["owner@example.test", "sync on", true, false],
        ["other@example.test", "needs a reconnect", true, true],
      ]);
      const [ok, waiting] = rows;
      expect(ok!.last_success_at).not.toBeNull();
      expect(ok!.last_run).toMatchObject({ status: "success", items: 12 });
      // A fresh Google grant is inside its test-mode window.
      expect(ok!.grant_expiry).toMatchObject({ state: "upcoming", days: 7 });
      expect(waiting!.status_reason).toBe("invalid_grant");
      expect(waiting!.reconnect_since).not.toBeNull();
      expect(JSON.stringify(rows)).not.toContain("rt-1");
    } finally { await db.close(); }
  });

  it("doctor connector-health covers accounts, not only recipe runs", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      expect((await checkConnectorHealth(e)).detail).toBe("no connector account and no connector has run");
      const a = await seedAccount(e);
      await setAccountEnabled(e, a.id, true);
      await markAccountSynced(e, a.id);
      await recordAccountRun(e, a.id, result(), new Date());
      const ok = await checkConnectorHealth(e);
      expect(ok.status).toBe("ok");
      expect(ok.detail).toContain(`google/${a.id.slice(0, 8)} into cal: sync on`);
      expect(ok.detail).toContain("last run success");
      // Doctor output can reach an MCP client: no mailbox address in it.
      expect(ok.detail).not.toContain("owner@example.test");

      await markNeedsReconnect(e, a.id, "invalid_grant");
      await openNotice(e, a.id, "needs_reconnect", "google account for source 'cal' needs a reconnect");
      const warn = await checkConnectorHealth(e);
      expect(warn.status).toBe("warn");
      expect(warn.detail).toContain(`google/${a.id.slice(0, 8)} into cal: needs a reconnect`);
      // One line for the account, not one more for its notice.
      expect(warn.detail.match(/needs a reconnect/g)).toHaveLength(1);
    } finally { await db.close(); }
  });

  it("doctor still names the healthy accounts while another one warns", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const ok = await seedAccount(e, "owner@example.test");
      const parked = await seedAccount(e, "other@example.test");
      await setAccountEnabled(e, ok.id, true);
      await markAccountSynced(e, ok.id);
      await markNeedsReconnect(e, parked.id, "invalid_grant");
      const r = await checkConnectorHealth(e);
      expect(r.status).toBe("warn");
      expect(r.detail).toContain(`google/${parked.id.slice(0, 8)} into cal: needs a reconnect`);
      expect(r.detail).toContain(`google/${ok.id.slice(0, 8)} into cal: sync on`);
      // The problem comes first.
      expect(r.detail.indexOf(parked.id.slice(0, 8))).toBeLessThan(r.detail.indexOf(ok.id.slice(0, 8)));
    } finally { await db.close(); }
  });

  it("doctor warns from day five of a Google test-mode grant, and names the limit when it lapses", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const a = await seedAccount(e);
      await setAccountEnabled(e, a.id, true);
      await markAccountSynced(e, a.id);
      await e.query(`UPDATE connector_credentials SET created_at = NOW() - INTERVAL '5 days 2 hours' WHERE account_id = $1`, [a.id]);
      await e.query(`UPDATE connector_accounts SET last_success_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [a.id]);
      const soon = await checkConnectorHealth(e);
      expect(soon.status).toBe("warn");
      expect(soon.detail).toContain("Google ends a Testing-mode grant 7 days after consent");

      await e.query(`UPDATE connector_credentials SET created_at = NOW() - INTERVAL '7 days 1 hour' WHERE account_id = $1`, [a.id]);
      await markNeedsReconnect(e, a.id, "invalid_grant");
      const lapsed = await checkConnectorHealth(e);
      expect(lapsed.detail).toContain("needs a reconnect");
      expect(lapsed.detail).toContain("likely the 7-day Testing-mode limit");
    } finally { await db.close(); }
  });

  it("records a run stopped by the account's cap, so status does not keep showing the last good run", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const a = await seedAccount(e);
      await setAccountEnabled(e, a.id, true);
      await recordAccountRun(e, a.id, result(), new Date(G));
      await e.query(`UPDATE connector_accounts SET spend_cap_usd_daily = 0 WHERE id = $1`, [a.id]);
      const rt = connectorRuntime(db.storage, { kek, providers: builtinProviders(), env: { MEMRAIN_CONNECTORS_ENABLED: "1" } });
      const account = (await rt.loadAccount(a.id))!;
      const r = await runConnectorSync(db.storage, account, rt.depsFor(account));
      expect(r).toMatchObject({ status: "partial", stop_reason: "cap_reached" });
      expect(await readAccountRun(e, a.id)).toMatchObject({ status: "partial", stop_reason: "cap_reached" });
    } finally { await db.close(); }
  });

  it("the production runtime records every account run it reports", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const a = await seedAccount(e);
      const rt = connectorRuntime(db.storage, { kek, providers: builtinProviders(), env: { MEMRAIN_CONNECTORS_ENABLED: "1" } });
      const account = (await rt.loadAccount(a.id))!;
      const gateway = rt.depsFor(account).accounts;
      expect(gateway.recordRun).toBeDefined();
      await gateway.recordRun!(a.id, result({ status: "nothing_new", counts: { ...result().counts, items: 0 } }));
      expect(await readAccountRun(e, a.id)).toMatchObject({ status: "nothing_new", items: 0 });
      await gateway.recordRun!(a.id, result({ status: "auth_required", stop_reason: "needs_reconnect", http_status: 400 }));
      expect(await readAccountRun(e, a.id)).toMatchObject({ status: "auth_required", stop_reason: "needs_reconnect", http_status: 400 });
    } finally { await db.close(); }
  });
});

describe("memrain connectors status", () => {
  const cliTmp = mkdtempSync(join(tmpdir(), "memrain-connectors-status-"));
  const cfgPath = join(cliTmp, "config.json");
  let log: ReturnType<typeof spyOn>;
  let accountId = "";

  beforeAll(async () => {
    writeFileSync(cfgPath, JSON.stringify({
      database: { type: "pglite", path: join(cliTmp, "brain.pglite") },
      embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
      storage: {},
    }));
    const s = new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));
    await s.init();
    try {
      const e = s.engine();
      await registerSource(e, { id: "me-calendar", kind: "calendar", pathPrefix: "calendar/" });
      const a = await createAccount(e, { sourceId: "me-calendar", provider: "google", services: ["calendar"], principalRef: "admin:operator", accountLabel: "owner@example.test" });
      await storeCredential(e, kek, a, { access_token: "at-cli", refresh_token: "rt-cli" }, { scopes: ["calendar.readonly"], expiresAt: null });
      await setAccountEnabled(e, a.id, true);
      await markAccountSynced(e, a.id);
      await recordAccountRun(e, a.id, result({ counts: { ...result().counts, items: 49, pages_written: 49 } }), new Date());
      accountId = a.id;
    } finally {
      await s.close();
    }
  });
  beforeEach(() => { log = spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => log.mockRestore());
  afterAll(() => rmSync(cliTmp, { recursive: true, force: true }));

  const printed = () => log.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

  it("lists syncing accounts instead of saying no connector has run", async () => {
    expect(await runConnectors({ sub: "status", configPath: cfgPath })).toBe(0);
    const out = printed();
    expect(out).not.toContain("no connector has run");
    expect(out).toContain(`google owner@example.test (${accountId.slice(0, 8)}) into me-calendar: sync on`);
    expect(out).toContain("last run success");
    expect(out).toContain("49 items, 49 written");
    expect(out).toContain("Testing");
    expect(out).not.toContain("rt-cli");
    // "sync on" is the account's switch; the first line says whether anything can run at all.
    expect(out.split("\n")[0]).toMatch(/^connectors: (on|off \(.+\))$/);
  });

  it("puts the accounts in the JSON next to the recipe connectors", async () => {
    expect(await runConnectors({ sub: "status", json: true, configPath: cfgPath })).toBe(0);
    const body = JSON.parse(String(log.mock.calls.at(-1)![0])) as { ok: boolean; connectors: unknown[]; accounts: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.connectors).toEqual([]);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      id: accountId, provider: "google", source_id: "me-calendar", state: "sync on", enabled: true, needs_reconnect: false,
      last_run: { status: "success", items: 49 }, grant_expiry: { state: "upcoming", days: 7 },
    });
    expect(body.accounts[0]!.last_success_at).not.toBeNull();
  });
});
