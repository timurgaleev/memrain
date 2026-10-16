/**
 * Admin passkey storage (migration 141) on PGLite: setup-link and recovery-code
 * reservation, atomic consume with the passkey insert, the counter CAS, the
 * last-passkey guard, audit hygiene and the failure-row cap.
 *
 * PGLite runs one statement at a time, so races are proven in
 * admin_passkey_store_pg.test.ts against a real Postgres.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Storage } from "../src/core/storage.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import {
  countPasskeys,
  credentialHash,
  deletePasskeyChecked,
  getPasskey,
  insertPasskeyForSession,
  insertPasskeyWithGrant,
  listAuthEvents,
  mintSetupLink,
  normalizeRecoveryCode,
  ownerHandle,
  PasskeyStoreError,
  pruneFailureEvents,
  recordAuthEvent,
  replaceRecoveryCodes,
  reserveRecoveryCode,
  reserveSetupLink,
  sha256Hex,
  unusedRecoveryCount,
  updateCounterCas,
  type NewPasskey,
} from "../src/core/admin-passkey-store.ts";

let tmp: string;
let storage: Storage;
const e = () => storage.engine();
const HOUR = 3_600_000;
const MIN = 60_000;
const A = sha256Hex("preauth-a");
const B = sha256Hex("preauth-b");

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-passkey-store-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
});
afterEach(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

function passkey(over: Partial<NewPasskey> = {}): NewPasskey {
  return {
    id: randomBytes(16).toString("base64url"),
    publicKey: randomBytes(77).toString("base64url"),
    counter: 0,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    aaguid: null,
    label: "Laptop",
    createdVia: "setup_link",
    ...over,
  };
}

async function tableExists(name: string): Promise<boolean> {
  const r = await e().query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [name]);
  return r.rows.length > 0;
}

async function linkRow(id: string): Promise<Record<string, unknown>> {
  return (await e().query<Record<string, unknown>>(`SELECT * FROM admin_setup_links WHERE id = $1`, [id])).rows[0]!;
}

describe("migration 141", () => {
  it("creates the five tables, and its down file reverts them", async () => {
    const tables = ["admin_owner", "admin_passkeys", "admin_recovery_codes", "admin_setup_links", "admin_auth_events"];
    for (const t of tables) expect(await tableExists(t)).toBe(true);
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 141).sort((a, b) => b - a);
    for (const id of later) await revertMigration(e(), id);
    await revertMigration(e(), 141);
    for (const t of tables) expect(await tableExists(t)).toBe(false);
    const again = await runMigrations(e());
    expect(again.applied.map((m) => m.id)).toEqual([141, ...later.reverse()]);
    for (const t of tables) expect(await tableExists(t)).toBe(true);
  });

  it("refuses its down when it is not the latest migration", async () => {
    await e().query(`INSERT INTO migrations (id, name) VALUES (9999, 'fake')`);
    await expect(revertMigration(e(), 141)).rejects.toThrow();
    expect(await tableExists("admin_passkeys")).toBe(true);
  });
});

describe("setup links", () => {
  it("stores only the token's hash, audits the issue with its surface, and keeps one link live", async () => {
    const first = await mintSetupLink(e(), { ttlMs: 24 * HOUR, via: "cli" });
    expect(first.token).toMatch(/^[\w-]{43}$/);
    const row = await linkRow(first.id);
    expect(row.nonce_hash).toBe(sha256Hex(first.token));
    expect(JSON.stringify(row)).not.toContain(first.token);
    const events = await listAuthEvents(e(), 10);
    expect(events.map((x) => [x.event, x.via])).toEqual([["setup_link.issued", "cli"]]);

    const second = await mintSetupLink(e(), { ttlMs: 24 * HOUR, via: "api" });
    expect((await linkRow(first.id)).revoked_at).not.toBeNull();
    expect((await linkRow(second.id)).revoked_at).toBeNull();
    const live = await e().query(`SELECT id FROM admin_setup_links WHERE revoked_at IS NULL AND used_at IS NULL`);
    expect(live.rows).toEqual([{ id: second.id }]);
    expect((await reserveSetupLink(e(), first.token, A, Date.now() + 15 * MIN)).ok).toBe(false);
  });

  it("reserves for one browser, refuses another until the reservation lapses, and consumes once", async () => {
    const t0 = Date.now();
    const link = await mintSetupLink(e(), { ttlMs: 24 * HOUR, via: "cli", nowMs: t0 });
    const r1 = await reserveSetupLink(e(), link.token, A, t0 + 15 * MIN, t0);
    expect(r1).toEqual({ ok: true, ref: link.id });
    // A retry from the same browser re-reserves; another browser is refused.
    expect((await reserveSetupLink(e(), link.token, A, t0 + 16 * MIN, t0 + MIN)).ok).toBe(true);
    expect(await reserveSetupLink(e(), link.token, B, t0 + 17 * MIN, t0 + 2 * MIN)).toEqual({ ok: false, reason: "reserved" });
    // After the reservation lapses another browser may take it.
    const t1 = t0 + 17 * MIN;
    expect((await reserveSetupLink(e(), link.token, B, t1 + 15 * MIN, t1)).ok).toBe(true);
    // A's grant lost its reservation: nothing is stored.
    await expect(
      insertPasskeyWithGrant(e(), passkey(), { source: "setup_link", ref: link.id, preauthHash: A }, t1),
    ).rejects.toMatchObject({ code: "grant_lost" });
    expect(await countPasskeys(e())).toBe(0);
    // B consumes it.
    const res = await insertPasskeyWithGrant(e(), passkey(), { source: "setup_link", ref: link.id, preauthHash: B }, t1);
    expect(res.first).toBe(true);
    expect(res.recoveryCodes).toHaveLength(10);
    expect((await linkRow(link.id)).used_at).not.toBeNull();
    expect(await reserveSetupLink(e(), link.token, B, t1 + 15 * MIN, t1)).toEqual({ ok: false, reason: "used" });
  });

  it("classifies expired, revoked, unknown and malformed tokens", async () => {
    const t0 = Date.now();
    const link = await mintSetupLink(e(), { ttlMs: HOUR, via: "panel", nowMs: t0 });
    expect(await reserveSetupLink(e(), link.token, A, t0 + 2 * HOUR, t0 + HOUR + 1)).toEqual({ ok: false, reason: "expired" });
    await mintSetupLink(e(), { ttlMs: HOUR, via: "panel", nowMs: t0 });
    expect(await reserveSetupLink(e(), link.token, A, t0 + 15 * MIN, t0)).toEqual({ ok: false, reason: "revoked" });
    expect(await reserveSetupLink(e(), randomBytes(32).toString("base64url"), A, t0, t0)).toEqual({ ok: false, reason: "unknown" });
    expect(await reserveSetupLink(e(), "short", A, t0, t0)).toEqual({ ok: false, reason: "malformed" });
  });

  it("a duplicate credential id rolls back without consuming the grant", async () => {
    const t0 = Date.now();
    const existing = passkey({ createdVia: "session" });
    await insertPasskeyForSession(e(), existing, t0);
    const link = await mintSetupLink(e(), { ttlMs: HOUR, via: "cli", nowMs: t0 });
    await reserveSetupLink(e(), link.token, A, t0 + 15 * MIN, t0);
    await expect(
      insertPasskeyWithGrant(e(), passkey({ id: existing.id }), { source: "setup_link", ref: link.id, preauthHash: A }, t0),
    ).rejects.toBeInstanceOf(PasskeyStoreError);
    expect((await linkRow(link.id)).used_at).toBeNull();
    expect(await countPasskeys(e())).toBe(1);
  });
});

describe("recovery codes", () => {
  it("reserve + consume once; reuse fails; malformed input is rejected", async () => {
    const t0 = Date.now();
    const codes = await replaceRecoveryCodes(e(), t0);
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^(?:[0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(codes).size).toBe(10);
    // Lower case, spaces and the Crockford look-alikes are normalized.
    const typed = codes[0]!.toLowerCase().replace(/-/g, " ");
    const r = await reserveRecoveryCode(e(), typed, A, t0 + 15 * MIN, t0);
    expect(r).toEqual({ ok: true, ref: sha256Hex(codes[0]!.replace(/-/g, "")) });
    expect(await reserveRecoveryCode(e(), codes[0]!, B, t0 + 15 * MIN, t0)).toEqual({ ok: false, reason: "reserved" });
    await insertPasskeyWithGrant(e(), passkey({ createdVia: "recovery" }), { source: "recovery", ref: (r as { ref: string }).ref, preauthHash: A }, t0);
    expect(await reserveRecoveryCode(e(), codes[0]!, A, t0 + 15 * MIN, t0)).toEqual({ ok: false, reason: "used" });
    expect(await unusedRecoveryCount(e())).toBe(9);
    expect(await reserveRecoveryCode(e(), "AAAA-BBBB", A, t0, t0)).toEqual({ ok: false, reason: "malformed" });
    expect(await reserveRecoveryCode(e(), "U".repeat(24), A, t0, t0)).toEqual({ ok: false, reason: "malformed" });
    expect(normalizeRecoveryCode("o0il-0000-0000-0000-0000-0000")).toBe("001100000000000000000000");
  });

  it("regenerating invalidates the whole old set, and a reserved grant on it is lost", async () => {
    const t0 = Date.now();
    const old = await replaceRecoveryCodes(e(), t0);
    const r = await reserveRecoveryCode(e(), old[3]!, A, t0 + 15 * MIN, t0);
    const fresh = await replaceRecoveryCodes(e(), t0);
    for (const c of old) expect((await reserveRecoveryCode(e(), c, B, t0 + 15 * MIN, t0)).ok).toBe(false);
    expect((await reserveRecoveryCode(e(), fresh[0]!, B, t0 + 15 * MIN, t0)).ok).toBe(true);
    await expect(
      insertPasskeyWithGrant(e(), passkey({ createdVia: "recovery" }), { source: "recovery", ref: (r as { ref: string }).ref, preauthHash: A }, t0),
    ).rejects.toMatchObject({ code: "grant_lost" });
  });

  it("a registration that leaves no unused code issues a fresh set of 10", async () => {
    const t0 = Date.now();
    const first = await insertPasskeyForSession(e(), passkey({ createdVia: "session" }), t0);
    expect(first.recoveryCodes).toHaveLength(10);
    const second = await insertPasskeyForSession(e(), passkey({ createdVia: "session" }), t0);
    expect(second.recoveryCodes).toBeUndefined();
    // Spend all but one, then the last through a recovery enrollment.
    await e().query(`UPDATE admin_recovery_codes SET used_at = now() WHERE code_hash IN (SELECT code_hash FROM admin_recovery_codes ORDER BY code_hash LIMIT 9)`);
    let lastLeft: string | null = null;
    for (const c of first.recoveryCodes!) {
      const h = sha256Hex(normalizeRecoveryCode(c)!);
      const used = await e().query<{ used_at: unknown }>(`SELECT used_at FROM admin_recovery_codes WHERE code_hash = $1`, [h]);
      if (used.rows[0]!.used_at === null) lastLeft = c;
    }
    expect(lastLeft).not.toBeNull();
    const r = await reserveRecoveryCode(e(), lastLeft!, A, t0 + 15 * MIN, t0);
    const third = await insertPasskeyWithGrant(e(), passkey({ createdVia: "recovery" }), { source: "recovery", ref: (r as { ref: string }).ref, preauthHash: A }, t0);
    expect(third.recoveryCodes).toHaveLength(10);
    expect(third.first).toBe(false);
    expect(await unusedRecoveryCount(e())).toBe(10);
  });
});

describe("passkeys", () => {
  it("updateCounterCas moves only from the stored value, and only forward (0/0 allowed)", async () => {
    const pk = passkey({ counter: 5 });
    await insertPasskeyForSession(e(), pk);
    expect(await updateCounterCas(e(), pk.id, 4, 6)).toBe(false);
    expect(await updateCounterCas(e(), pk.id, 5, 5)).toBe(false);
    expect(await updateCounterCas(e(), pk.id, 5, 3)).toBe(false);
    expect(await updateCounterCas(e(), pk.id, 5, 6)).toBe(true);
    expect(await updateCounterCas(e(), pk.id, 5, 7)).toBe(false);
    expect((await getPasskey(e(), pk.id))!.counter).toBe(6);
    const synced = passkey();
    await insertPasskeyForSession(e(), synced);
    expect(await updateCounterCas(e(), synced.id, 0, 0)).toBe(true);
    expect(await updateCounterCas(e(), synced.id, 0, 0)).toBe(true);
    expect((await getPasskey(e(), synced.id))!.lastUsedAt).not.toBeNull();
  });

  it("deletePasskeyChecked refuses the last one without confirmLast", async () => {
    const a = passkey();
    const b = passkey();
    await insertPasskeyForSession(e(), a);
    await insertPasskeyForSession(e(), b);
    await deletePasskeyChecked(e(), a.id, false);
    await expect(deletePasskeyChecked(e(), b.id, false)).rejects.toMatchObject({ code: "last_passkey" });
    await expect(deletePasskeyChecked(e(), "nope", true)).rejects.toMatchObject({ code: "not_found" });
    await deletePasskeyChecked(e(), b.id, true);
    expect(await countPasskeys(e())).toBe(0);
  });

  it("round-trips a 77-byte COSE key, a counter above 2^31 and the transports", async () => {
    const pk = passkey({ counter: 2 ** 31 + 7, publicKey: randomBytes(77).toString("base64url") });
    await insertPasskeyForSession(e(), pk);
    const got = (await getPasskey(e(), pk.id))!;
    expect(got.publicKey).toBe(pk.publicKey);
    expect(Buffer.from(got.publicKey, "base64url")).toHaveLength(77);
    expect(got.counter).toBe(2 ** 31 + 7);
    expect(got.transports).toEqual(["internal", "hybrid"]);
    expect(await updateCounterCas(e(), pk.id, 2 ** 31 + 7, 2 ** 32 - 1)).toBe(true);
  });

  it("ownerHandle is stable", async () => {
    const h = await ownerHandle(e());
    expect(Buffer.from(h, "base64url")).toHaveLength(32);
    expect(await ownerHandle(e())).toBe(h);
  });
});

describe("audit log", () => {
  it("holds no token, code, raw credential id or pre-auth id in any column", async () => {
    const t0 = Date.now();
    const preauth = randomBytes(32).toString("hex");
    const link = await mintSetupLink(e(), { ttlMs: HOUR, via: "cli", nowMs: t0 });
    await reserveSetupLink(e(), link.token, sha256Hex(preauth), t0 + 15 * MIN, t0);
    const pk = passkey();
    const res = await insertPasskeyWithGrant(e(), pk, { source: "setup_link", ref: link.id, preauthHash: sha256Hex(preauth) }, t0);
    await recordAuthEvent(e(), { event: "passkey.registered", outcome: "ok", via: "setup_link", credential: credentialHash(pk.id) });
    const all = await e().query<Record<string, unknown>>(`SELECT * FROM admin_auth_events`);
    const dump = JSON.stringify(all.rows);
    expect(all.rows.length).toBeGreaterThanOrEqual(3);
    for (const secret of [link.token, pk.id, preauth, sha256Hex(preauth), ...res.recoveryCodes!, ...res.recoveryCodes!.map((c) => c.replace(/-/g, ""))]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("pruneFailureEvents keeps the newest N failure rows and every ok or notice row", async () => {
    for (let i = 0; i < 25; i++) await recordAuthEvent(e(), { event: "passkey.login_failed", outcome: "fail", reason: `r${i}` });
    for (let i = 0; i < 3; i++) await recordAuthEvent(e(), { event: "passkey.login", outcome: "ok" });
    await recordAuthEvent(e(), { event: "passkey.counter_regression", outcome: "fail", notice: true });
    await pruneFailureEvents(e(), 10);
    const rows = await e().query<{ outcome: string; reason: string | null; notice: boolean }>(
      `SELECT outcome, reason, notice FROM admin_auth_events ORDER BY id`,
    );
    const fails = rows.rows.filter((r) => r.outcome === "fail" && !r.notice);
    expect(fails.map((r) => r.reason)).toEqual(Array.from({ length: 10 }, (_, i) => `r${i + 15}`));
    expect(rows.rows.filter((r) => r.outcome === "ok")).toHaveLength(3);
    expect(rows.rows.filter((r) => r.notice)).toHaveLength(1);
  });
});
