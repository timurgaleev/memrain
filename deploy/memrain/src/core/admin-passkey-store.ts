/**
 * Storage for admin passkey sign-in (migration 141).
 *
 * One owner, so every mutation that has to see a consistent picture of the
 * owner's credentials (insert, last-passkey revoke, minting a setup link,
 * replacing recovery codes) runs in a transaction that first locks the single
 * `admin_owner` row. A row lock needs no session state, so it holds behind a
 * transaction pooler too.
 *
 * Secrets never land in a column: recovery codes and setup tokens are stored as
 * SHA-256 hex and looked up by that hash, so no secret is compared in JS. A
 * redeemed link or code is first RESERVED for the pre-auth browser that
 * redeemed it and only consumed in the transaction that stores the passkey, so
 * a cancelled ceremony gives it back once the reservation lapses.
 *
 * Times that decide expiry are passed in from the caller's clock rather than
 * read from `now()`, so a reservation, a link expiry and a cooldown are all
 * measured on one clock.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./engine/interface.ts";

export const RECOVERY_CODE_COUNT = 10;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CODE_CHARS = 24; // 120 bits
const SETUP_TOKEN_RE = /^[\w-]{43}$/;

export type PasskeyCreatedVia = "setup_link" | "recovery" | "session";
export type SetupLinkVia = "cli" | "api" | "panel";
export type AuthEventVia = SetupLinkVia | PasskeyCreatedVia;

export type PasskeyStoreErrorCode = "credential_exists" | "grant_lost" | "last_passkey" | "not_found";

export class PasskeyStoreError extends Error {
  constructor(readonly code: PasskeyStoreErrorCode) {
    super(code);
  }
}

export interface PasskeyRecord {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  aaguid: string | null;
  label: string;
  createdVia: PasskeyCreatedVia;
  /** First passkey of the owner, created from a setup link; never in cooldown. */
  initial: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface NewPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  aaguid: string | null;
  label: string;
  createdVia: PasskeyCreatedVia;
}

export interface EnrollGrantRef {
  source: "setup_link" | "recovery";
  /** Setup link id, or the recovery code's hash. */
  ref: string;
  /** sha256 of the pre-auth id the reservation was made for. */
  preauthHash: string;
}

export interface InsertResult {
  /** Plaintext codes when this insert left none unused and issued a fresh set. */
  recoveryCodes?: string[];
  /** True when no passkey existed before this one. */
  first: boolean;
  /** Stored as the owner's initial passkey (first, from a setup link). */
  initial: boolean;
}

export type ReserveFailure = "unknown" | "used" | "expired" | "revoked" | "reserved" | "malformed";
export type ReserveResult = { ok: true; ref: string } | { ok: false; reason: ReserveFailure };

export interface AuthEventInput {
  event: string;
  outcome: "ok" | "fail";
  reason?: string | null;
  via?: AuthEventVia | null;
  /** Already hashed with `credentialHash`, never a raw credential id. */
  credential?: string | null;
  clientKey?: string | null;
  userAgent?: string | null;
  notice?: boolean;
  at?: number;
}

export interface AuthEventRecord {
  id: number;
  at: number;
  event: string;
  outcome: "ok" | "fail";
  reason: string | null;
  via: string | null;
  credential: string | null;
  clientKey: string | null;
  userAgent: string | null;
  notice: boolean;
  noticedAt: number | null;
  noticedBy: string | null;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The form a credential id takes in the audit log: never the raw id. */
export function credentialHash(credentialId: string): string {
  return sha256Hex(credentialId).slice(0, 16);
}

const iso = (ms: number): string => new Date(ms).toISOString();

function toMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return new Date(String(v)).getTime();
}

function toMsOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toMs(v);
}

function base32Crockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** Uppercase, strip separators, fold the Crockford look-alikes. Null when the
 *  input cannot be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== RECOVERY_CODE_CHARS) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

function formatRecoveryCode(code: string): string {
  return code.match(/.{4}/g)!.join("-");
}

function newRecoveryCode(): string {
  return base32Crockford(randomBytes(15));
}

/** Create the owner row if missing and return its user handle (base64url). */
export async function ownerHandle(e: Engine): Promise<string> {
  await e.query(
    `INSERT INTO admin_owner (id, user_handle) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
    [randomBytes(32).toString("base64url")],
  );
  const r = await e.query<{ user_handle: string }>(`SELECT user_handle FROM admin_owner WHERE id = 1`);
  return r.rows[0]!.user_handle;
}

async function lockOwner(tx: Engine): Promise<void> {
  await ownerHandle(tx);
  await tx.query(`SELECT id FROM admin_owner WHERE id = 1 FOR UPDATE`);
}

interface PasskeyRow {
  id: string;
  public_key: string;
  counter: unknown;
  transports: string[] | null;
  device_type: "singleDevice" | "multiDevice";
  backed_up: boolean;
  aaguid: string | null;
  label: string;
  created_via: PasskeyCreatedVia;
  initial: boolean;
  created_at: unknown;
  last_used_at: unknown;
}

const PASSKEY_COLUMNS =
  "id, public_key, counter, transports, device_type, backed_up, aaguid, label, created_via, initial, created_at, last_used_at";

function toRecord(r: PasskeyRow): PasskeyRecord {
  return {
    id: r.id,
    publicKey: r.public_key,
    counter: Number(r.counter),
    transports: r.transports ?? [],
    deviceType: r.device_type,
    backedUp: r.backed_up,
    aaguid: r.aaguid,
    label: r.label,
    createdVia: r.created_via,
    initial: r.initial === true,
    createdAt: toMs(r.created_at),
    lastUsedAt: toMsOrNull(r.last_used_at),
  };
}

export async function listPasskeys(e: Engine): Promise<PasskeyRecord[]> {
  const r = await e.query<PasskeyRow>(`SELECT ${PASSKEY_COLUMNS} FROM admin_passkeys ORDER BY created_at, id`);
  return r.rows.map(toRecord);
}

export async function getPasskey(e: Engine, id: string): Promise<PasskeyRecord | null> {
  const r = await e.query<PasskeyRow>(`SELECT ${PASSKEY_COLUMNS} FROM admin_passkeys WHERE id = $1`, [id]);
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}

export async function countPasskeys(e: Engine): Promise<number> {
  const r = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_passkeys`);
  return Number(r.rows[0]!.n);
}

export async function renamePasskey(e: Engine, id: string, label: string): Promise<boolean> {
  const r = await e.query(`UPDATE admin_passkeys SET label = $2 WHERE id = $1 RETURNING id`, [id, label]);
  return r.rows.length > 0;
}

async function issueRecoveryCodes(tx: Engine, nowMs: number): Promise<string[]> {
  await tx.query(`DELETE FROM admin_recovery_codes`);
  const batch = randomBytes(8).toString("hex");
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const code = newRecoveryCode();
    codes.push(formatRecoveryCode(code));
    await tx.query(
      `INSERT INTO admin_recovery_codes (code_hash, batch_id, created_at) VALUES ($1, $2, $3::timestamptz)`,
      [sha256Hex(code), batch, iso(nowMs)],
    );
  }
  return codes;
}

async function insertPasskeyLocked(
  tx: Engine,
  row: NewPasskey,
  grant: EnrollGrantRef | null,
  nowMs: number,
): Promise<InsertResult> {
  await lockOwner(tx);
  const before = Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_passkeys`)).rows[0]!.n);
  const initial = before === 0 && row.createdVia === "setup_link";
  const ins = await tx.query(
    `INSERT INTO admin_passkeys
       (id, public_key, counter, transports, device_type, backed_up, aaguid, label, created_via, initial, created_at)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::timestamptz)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      row.id, row.publicKey, row.counter, row.transports, row.deviceType, row.backedUp,
      row.aaguid, row.label, row.createdVia, initial, iso(nowMs),
    ],
  );
  if (ins.rows.length === 0) throw new PasskeyStoreError("credential_exists");
  if (grant) {
    const consumed = grant.source === "setup_link"
      ? await tx.query(
          `UPDATE admin_setup_links SET used_at = $3::timestamptz
            WHERE id = $1 AND reserved_for = $2 AND used_at IS NULL AND revoked_at IS NULL
            RETURNING id`,
          [grant.ref, grant.preauthHash, iso(nowMs)],
        )
      : await tx.query(
          `UPDATE admin_recovery_codes SET used_at = $3::timestamptz
            WHERE code_hash = $1 AND reserved_for = $2 AND used_at IS NULL
            RETURNING code_hash`,
          [grant.ref, grant.preauthHash, iso(nowMs)],
        );
    if (consumed.rows.length === 0) throw new PasskeyStoreError("grant_lost");
  }
  const unused = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM admin_recovery_codes WHERE used_at IS NULL`,
  );
  const result: InsertResult = { first: before === 0, initial };
  if (Number(unused.rows[0]!.n) === 0) {
    result.recoveryCodes = await issueRecoveryCodes(tx, nowMs);
    await insertEvent(tx, { event: "recovery.issued", outcome: "ok", via: row.createdVia, at: nowMs });
  }
  return result;
}

/** Store a passkey created under an enrollment grant and consume the grant's
 *  setup link or recovery code in the same transaction. A grant that lost its
 *  reservation stores nothing. */
export async function insertPasskeyWithGrant(
  e: Engine,
  row: NewPasskey,
  grant: EnrollGrantRef,
  nowMs: number = Date.now(),
): Promise<InsertResult> {
  return e.transaction((tx) => insertPasskeyLocked(tx, row, grant, nowMs));
}

export async function insertPasskeyForSession(
  e: Engine,
  row: NewPasskey,
  nowMs: number = Date.now(),
): Promise<InsertResult> {
  return e.transaction((tx) => insertPasskeyLocked(tx, row, null, nowMs));
}

/** Delete a passkey, refusing the last one unless `confirmLast`. */
export async function deletePasskeyChecked(e: Engine, id: string, confirmLast: boolean): Promise<void> {
  await e.transaction(async (tx) => {
    await lockOwner(tx);
    const exists = await tx.query(`SELECT id FROM admin_passkeys WHERE id = $1`, [id]);
    if (exists.rows.length === 0) throw new PasskeyStoreError("not_found");
    const n = Number((await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_passkeys`)).rows[0]!.n);
    if (n <= 1 && !confirmLast) throw new PasskeyStoreError("last_passkey");
    await tx.query(`DELETE FROM admin_passkeys WHERE id = $1`, [id]);
  });
}

/**
 * Move the signature counter from `stored` to `next`, only if nobody moved it
 * in between. Both zero (synced passkeys never count) is accepted. False when
 * another sign-in won the race or the counter would not advance.
 */
export async function updateCounterCas(
  e: Engine,
  id: string,
  stored: number,
  next: number,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const r = await e.query(
    `UPDATE admin_passkeys SET counter = $3, last_used_at = $4::timestamptz
      WHERE id = $1 AND counter = $2 AND ($3 > $2 OR ($2 = 0 AND $3 = 0))
      RETURNING id`,
    [id, stored, next, iso(nowMs)],
  );
  return r.rows.length > 0;
}

/**
 * Mint a setup link. Every outstanding unused link is revoked first, so only
 * one can be live, and the issue is audited in the same transaction whichever
 * surface asked for it. The token is returned once; only its hash is kept.
 */
export async function mintSetupLink(
  e: Engine,
  opts: { ttlMs: number; via: SetupLinkVia; nowMs?: number; clientKey?: string | null; userAgent?: string | null },
): Promise<{ id: string; token: string; expiresAt: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const token = randomBytes(32).toString("base64url");
  const id = randomBytes(12).toString("hex");
  const expiresAt = nowMs + opts.ttlMs;
  await e.transaction(async (tx) => {
    await lockOwner(tx);
    await tx.query(
      `UPDATE admin_setup_links SET revoked_at = $1::timestamptz WHERE used_at IS NULL AND revoked_at IS NULL`,
      [iso(nowMs)],
    );
    await tx.query(
      `INSERT INTO admin_setup_links (id, nonce_hash, created_via, created_at, expires_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [id, sha256Hex(token), opts.via, iso(nowMs), iso(expiresAt)],
    );
    await insertEvent(tx, {
      event: "setup_link.issued",
      outcome: "ok",
      via: opts.via,
      clientKey: opts.clientKey ?? null,
      userAgent: opts.userAgent ?? null,
      at: nowMs,
    });
  });
  return { id, token, expiresAt };
}

/** Revoke every unused, unrevoked setup link. Returns how many. */
export async function revokeUnusedSetupLinks(e: Engine, nowMs: number = Date.now()): Promise<number> {
  const r = await e.query(
    `UPDATE admin_setup_links SET revoked_at = $1::timestamptz
      WHERE used_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [iso(nowMs)],
  );
  return r.rows.length;
}

interface ReservableRow {
  used_at: unknown;
  revoked_at?: unknown;
  expires_at?: unknown;
}

/**
 * Reserve a setup link for the pre-auth browser `preauthHash` until `untilMs`.
 * A link already reserved by the same browser is re-reserved (a retry after a
 * cancelled ceremony); one reserved by another browser is refused until the
 * reservation lapses. The failure reason is for the audit log only.
 */
export async function reserveSetupLink(
  e: Engine,
  token: string,
  preauthHash: string,
  untilMs: number,
  nowMs: number = Date.now(),
): Promise<ReserveResult> {
  if (!SETUP_TOKEN_RE.test(token)) return { ok: false, reason: "malformed" };
  const hash = sha256Hex(token);
  const r = await e.query<{ id: string }>(
    `UPDATE admin_setup_links SET reserved_for = $2, reserved_until = $3::timestamptz
      WHERE nonce_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $4::timestamptz
        AND (reserved_until IS NULL OR reserved_until < $4::timestamptz OR reserved_for = $2)
      RETURNING id`,
    [hash, preauthHash, iso(untilMs), iso(nowMs)],
  );
  if (r.rows[0]) return { ok: true, ref: r.rows[0].id };
  const row = (await e.query<ReservableRow>(
    `SELECT used_at, revoked_at, expires_at FROM admin_setup_links WHERE nonce_hash = $1`,
    [hash],
  )).rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at !== null) return { ok: false, reason: "used" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (toMs(row.expires_at) <= nowMs) return { ok: false, reason: "expired" };
  return { ok: false, reason: "reserved" };
}

/** Same reservation rule as setup links, for a recovery code. `ref` is the
 *  code's hash. */
export async function reserveRecoveryCode(
  e: Engine,
  code: string,
  preauthHash: string,
  untilMs: number,
  nowMs: number = Date.now(),
): Promise<ReserveResult> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return { ok: false, reason: "malformed" };
  const hash = sha256Hex(normalized);
  const r = await e.query<{ code_hash: string }>(
    `UPDATE admin_recovery_codes SET reserved_for = $2, reserved_until = $3::timestamptz
      WHERE code_hash = $1 AND used_at IS NULL
        AND (reserved_until IS NULL OR reserved_until < $4::timestamptz OR reserved_for = $2)
      RETURNING code_hash`,
    [hash, preauthHash, iso(untilMs), iso(nowMs)],
  );
  if (r.rows[0]) return { ok: true, ref: r.rows[0].code_hash };
  const row = (await e.query<ReservableRow>(
    `SELECT used_at FROM admin_recovery_codes WHERE code_hash = $1`,
    [hash],
  )).rows[0];
  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at !== null) return { ok: false, reason: "used" };
  return { ok: false, reason: "reserved" };
}

/** Replace the whole recovery set; the old codes stop working at once. */
export async function replaceRecoveryCodes(e: Engine, nowMs: number = Date.now()): Promise<string[]> {
  return e.transaction(async (tx) => {
    await lockOwner(tx);
    return issueRecoveryCodes(tx, nowMs);
  });
}

export async function unusedRecoveryCount(e: Engine): Promise<number> {
  const r = await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM admin_recovery_codes WHERE used_at IS NULL`);
  return Number(r.rows[0]!.n);
}

async function insertEvent(e: Engine, ev: AuthEventInput): Promise<void> {
  await e.query(
    `INSERT INTO admin_auth_events (at, event, outcome, reason, via, credential, client_key, user_agent, notice)
     VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      iso(ev.at ?? Date.now()), ev.event, ev.outcome, ev.reason ?? null, ev.via ?? null,
      ev.credential ?? null, ev.clientKey ?? null, ev.userAgent ? ev.userAgent.slice(0, 200) : null,
      ev.notice === true,
    ],
  );
}

export async function recordAuthEvent(e: Engine, ev: AuthEventInput): Promise<void> {
  await insertEvent(e, ev);
}

interface EventRow {
  id: unknown;
  at: unknown;
  event: string;
  outcome: "ok" | "fail";
  reason: string | null;
  via: string | null;
  credential: string | null;
  client_key: string | null;
  user_agent: string | null;
  notice: boolean;
  noticed_at: unknown;
  noticed_by: string | null;
}

const EVENT_COLUMNS =
  "id, at, event, outcome, reason, via, credential, client_key, user_agent, notice, noticed_at, noticed_by";

function toEvent(r: EventRow): AuthEventRecord {
  return {
    id: Number(r.id),
    at: toMs(r.at),
    event: r.event,
    outcome: r.outcome,
    reason: r.reason,
    via: r.via,
    credential: r.credential,
    clientKey: r.client_key,
    userAgent: r.user_agent,
    notice: r.notice,
    noticedAt: toMsOrNull(r.noticed_at),
    noticedBy: r.noticed_by,
  };
}

export async function listAuthEvents(e: Engine, limit: number): Promise<AuthEventRecord[]> {
  const r = await e.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM admin_auth_events ORDER BY at DESC, id DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map(toEvent);
}

export async function pendingNotices(e: Engine): Promise<AuthEventRecord[]> {
  const r = await e.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM admin_auth_events
      WHERE notice AND noticed_at IS NULL ORDER BY at, id`,
  );
  return r.rows.map(toEvent);
}

/** Mark these notices seen. The row stays in the log. */
export async function ackNotices(e: Engine, ids: number[], by: string, nowMs: number = Date.now()): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await e.query(
    `UPDATE admin_auth_events SET noticed_at = $2::timestamptz, noticed_by = $3
      WHERE id = ANY($1::bigint[]) AND notice AND noticed_at IS NULL RETURNING id`,
    [ids, iso(nowMs), by],
  );
  return r.rows.length;
}

/** Keep the newest `keep` failure rows; ok and notice rows are never pruned. */
export async function pruneFailureEvents(e: Engine, keep: number = 10_000): Promise<number> {
  const r = await e.query(
    `DELETE FROM admin_auth_events
      WHERE outcome = 'fail' AND NOT notice
        AND id < (SELECT id FROM admin_auth_events WHERE outcome = 'fail' AND NOT notice
                   ORDER BY id DESC OFFSET $1 LIMIT 1)
      RETURNING id`,
    [Math.max(0, keep - 1)],
  );
  return r.rows.length;
}
