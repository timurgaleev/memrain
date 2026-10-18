/**
 * Admin passkey storage against a real Postgres, where two transactions do run
 * at once (PGLite serializes them, so it cannot show these races). Each race
 * runs over two separate engines, i.e. separate connections. Skipped unless
 * MEMRAIN_TEST_POSTGRES_URL points at a scratch database with pgvector.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { PostgresEngine } from "../src/core/engine/postgres.ts";
import { Storage } from "../src/core/storage.ts";
import { discoverMigrations, revertMigration, runMigrations } from "../src/core/migrate.ts";
import {
  deletePasskeyChecked,
  getPasskey,
  insertPasskeyForSession,
  mintSetupLink,
  ownerHandle,
  replaceRecoveryCodes,
  reserveRecoveryCode,
  reserveSetupLink,
  sha256Hex,
  updateCounterCas,
  type NewPasskey,
  type ReserveResult,
} from "../src/core/admin-passkey-store.ts";

const URL_ = process.env.MEMRAIN_TEST_POSTGRES_URL;
const MIN = 60_000;
const ROUNDS = 15;

function passkey(over: Partial<NewPasskey> = {}): NewPasskey {
  return {
    id: randomBytes(16).toString("base64url"),
    publicKey: randomBytes(77).toString("base64url"),
    counter: 0,
    transports: ["internal", "hybrid"],
    deviceType: "multiDevice",
    backedUp: true,
    aaguid: null,
    label: "Key",
    createdVia: "session",
    ...over,
  };
}

describe.skipIf(!URL_)("admin passkey store on Postgres", () => {
  let a: PostgresEngine;
  let b: PostgresEngine;

  beforeAll(async () => {
    a = new PostgresEngine({ url: URL_!, max: 2 });
    b = new PostgresEngine({ url: URL_!, max: 2 });
    await new Storage(a).init();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });
  beforeEach(async () => {
    for (const t of ["admin_auth_events", "admin_setup_links", "admin_recovery_codes", "admin_passkeys", "admin_owner"]) {
      await a.query(`DELETE FROM ${t}`);
    }
  });

  it("migration 141 goes down and up again on Postgres", async () => {
    const later = discoverMigrations().map((m) => m.id).filter((id) => id > 141).sort((x, y) => y - x);
    for (const id of later) await revertMigration(a, id);
    await revertMigration(a, 141);
    const gone = await a.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'admin_passkeys'`);
    expect(gone.rows).toEqual([]);
    const again = await runMigrations(a);
    expect(again.applied.map((m) => m.id)).toEqual([141, ...later.reverse()]);
  });

  it("two browsers redeeming one setup link at once: exactly one reservation wins", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const link = await mintSetupLink(a, { ttlMs: 3_600_000, via: "cli" });
      const t = Date.now();
      const [x, y] = await Promise.all([
        reserveSetupLink(a, link.token, sha256Hex(`a${i}`), t + 15 * MIN, t),
        reserveSetupLink(b, link.token, sha256Hex(`b${i}`), t + 15 * MIN, t),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    }
  });

  it("two browsers redeeming one recovery code at once: exactly one reservation wins", async () => {
    const codes = await replaceRecoveryCodes(a);
    for (const code of codes) {
      const t = Date.now();
      const [x, y] = await Promise.all([
        reserveRecoveryCode(a, code, sha256Hex(`a${code}`), t + 15 * MIN, t),
        reserveRecoveryCode(b, code, sha256Hex(`b${code}`), t + 15 * MIN, t),
      ]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    }
  });

  // Four new reservations (each after the previous lease lapsed), then two
  // browsers race for the fifth: exactly one wins and it reports the cap.
  async function raceFifth(reserve: (eng: PostgresEngine, h: string, u: number, n: number) => Promise<ReserveResult>, tag: string): Promise<void> {
    const t = Date.now();
    for (let n = 0; n < 4; n++) {
      const now = t + n * 16 * MIN;
      expect((await reserve(a, sha256Hex(`${tag}h${n}`), now + 15 * MIN, now)).ok).toBe(true);
    }
    const now = t + 4 * 16 * MIN;
    const [x, y] = await Promise.all([
      reserve(a, sha256Hex(`${tag}x`), now + 15 * MIN, now),
      reserve(b, sha256Hex(`${tag}y`), now + 15 * MIN, now),
    ]);
    const won = [x, y].filter((r) => r.ok);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ capReached: true });
    expect([x, y].find((r) => !r.ok)).toMatchObject({ ok: false });
  }

  it("two browsers racing for a link's fifth reservation: exactly one wins and it reports the cap", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const link = await mintSetupLink(a, { ttlMs: 3_600_000 * 3, via: "cli" });
      await raceFifth((eng, h, u, n) => reserveSetupLink(eng, link.token, h, u, n), `l${i}`);
    }
    const notices = await a.query(`SELECT count(*)::int AS n FROM admin_auth_events WHERE event = 'setup_link.cap_reached' AND notice`);
    expect(Number((notices.rows[0] as { n: number }).n)).toBe(ROUNDS);
  });

  it("two browsers racing for a recovery code's fifth reservation: exactly one wins and it reports the cap", async () => {
    const codes = await replaceRecoveryCodes(a);
    for (const code of codes) await raceFifth((eng, h, u, n) => reserveRecoveryCode(eng, code, h, u, n), code);
    const notices = await a.query(`SELECT count(*)::int AS n FROM admin_auth_events WHERE event = 'recovery.cap_reached' AND notice`);
    expect(Number((notices.rows[0] as { n: number }).n)).toBe(codes.length);
  });

  it("concurrent mints leave exactly one live link", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      await Promise.all([
        mintSetupLink(a, { ttlMs: 3_600_000, via: "cli" }),
        mintSetupLink(b, { ttlMs: 3_600_000, via: "api" }),
      ]);
      const live = await a.query(`SELECT id FROM admin_setup_links WHERE used_at IS NULL AND revoked_at IS NULL`);
      expect(live.rows).toHaveLength(1);
    }
  });

  it("a mint waits for another transaction holding the owner lock", async () => {
    await ownerHandle(a);
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = a.transaction(async (tx) => {
      await tx.query(`SELECT id FROM admin_owner WHERE id = 1 FOR UPDATE`);
      locked();
      await released;
    });
    await lockedP;
    let done = false;
    const mint = mintSetupLink(b, { ttlMs: 3_600_000, via: "cli" }).then(() => (done = true));
    await Bun.sleep(300);
    expect(done).toBe(false);
    release();
    await holder;
    await mint;
    expect(done).toBe(true);
  });

  it("revoking the final two passkeys in parallel: exactly one succeeds", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      await a.query(`DELETE FROM admin_passkeys`);
      const x = passkey();
      const y = passkey();
      await insertPasskeyForSession(a, x);
      await insertPasskeyForSession(a, y);
      const r = await Promise.allSettled([deletePasskeyChecked(a, x.id, false), deletePasskeyChecked(b, y.id, false)]);
      expect(r.filter((s) => s.status === "fulfilled")).toHaveLength(1);
      const left = await a.query(`SELECT id FROM admin_passkeys`);
      expect(left.rows).toHaveLength(1);
    }
  });

  it("two counter updates from the same stored value: one wins, the counter never goes down", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const pk = passkey({ counter: 5 });
      await insertPasskeyForSession(a, pk);
      const [x, y] = await Promise.all([updateCounterCas(a, pk.id, 5, 7), updateCounterCas(b, pk.id, 5, 6)]);
      expect([x, y].filter(Boolean)).toHaveLength(1);
      const after = (await getPasskey(a, pk.id))!.counter;
      expect(after === 7 || after === 6).toBe(true);
      // Out of order: the lower value arriving late cannot lower it.
      expect(await updateCounterCas(b, pk.id, 5, 6)).toBe(false);
      expect((await getPasskey(a, pk.id))!.counter).toBe(after);
    }
  });

  it("parallel ownerHandle yields one handle; key, counter and transports round-trip", async () => {
    const handles = await Promise.all([ownerHandle(a), ownerHandle(b), ownerHandle(a), ownerHandle(b)]);
    expect(new Set(handles).size).toBe(1);
    const pk = passkey({ counter: 2 ** 31 + 9 });
    await insertPasskeyForSession(b, pk);
    const got = (await getPasskey(a, pk.id))!;
    expect(got.publicKey).toBe(pk.publicKey);
    expect(got.counter).toBe(2 ** 31 + 9);
    expect(got.transports).toEqual(["internal", "hybrid"]);
    expect(typeof got.createdAt).toBe("number");
  });
});
