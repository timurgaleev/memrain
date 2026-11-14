/**
 * Connector accounts and their encrypted credentials. Every read and write of
 * `connector_accounts` and `connector_credentials` goes through here.
 *
 * Account rows carry no secret; a credential is a vault envelope bound to its
 * account id and provider, so it only ever opens for the account it was
 * written for. Decrypted tokens are handed to the caller and, when asked,
 * added to an echo dictionary so the secret scanner redacts them if a provider
 * ever reflects one back into synced text.
 */
import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import type { EchoDictionary } from "../secret-scan.ts";
import { credentialAad, seal, unseal, type Kek } from "./vault.ts";

export const CONNECTOR_ACCOUNT_STATUSES = ["active", "paused", "needs_reconnect", "revoked", "error"] as const;
export type ConnectorAccountStatus = (typeof CONNECTOR_ACCOUNT_STATUSES)[number];

const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_LABEL = 320;
const MAX_PRINCIPAL = 200;
const MAX_REASON = 200;

export interface ConnectorAccount {
  id: string;
  source_id: string;
  provider: string;
  services: string[];
  principal_ref: string;
  account_label: string;
  status: ConnectorAccountStatus;
  status_reason: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  spend_cap_usd_daily: number;
  item_cap_daily: number;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
}

export interface CreateAccountInput {
  sourceId: string;
  provider: string;
  services: readonly string[];
  /** Who connected it: an admin session, PAT or member reference. */
  principalRef: string;
  /** Provider-side identity: the mailbox address or workspace name. */
  accountLabel: string;
  config?: Record<string, unknown>;
}

/** Thrown for input this module refuses before it reaches the database. */
export class ConnectorAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAccountError";
  }
}

const ACCOUNT_COLS =
  "id, source_id, provider, services, principal_ref, account_label, status, status_reason, enabled, config, " +
  "spend_cap_usd_daily, item_cap_daily, created_at, updated_at, last_success_at";

type RawAccount = Omit<ConnectorAccount, "spend_cap_usd_daily" | "item_cap_daily" | "created_at" | "updated_at" | "last_success_at"> & {
  spend_cap_usd_daily: number | string;
  item_cap_daily: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  last_success_at: Date | string | null;
};

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function toAccount(r: RawAccount): ConnectorAccount {
  return {
    ...r,
    services: [...(r.services ?? [])],
    spend_cap_usd_daily: Number(r.spend_cap_usd_daily),
    item_cap_daily: Number(r.item_cap_daily),
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
    last_success_at: iso(r.last_success_at),
  };
}

export function assertConnectorName(value: string, what: string): void {
  if (!NAME_RE.test(value)) throw new ConnectorAccountError(`invalid ${what}: use lowercase letters, digits and _`);
}

/** Printable text of bounded length, with no control characters. */
export function cleanLabel(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw new ConnectorAccountError(`invalid ${what}`);
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text === "" || text.length > max || /[\u0000-\u001F\u007F]/.test(text)) {
    throw new ConnectorAccountError(`invalid ${what}`);
  }
  return text;
}

export async function createAccount(engine: Engine, input: CreateAccountInput): Promise<ConnectorAccount> {
  assertConnectorName(input.provider, "provider");
  for (const s of input.services) assertConnectorName(s, "service");
  const label = cleanLabel(input.accountLabel, "account label", MAX_LABEL);
  const principal = cleanLabel(input.principalRef, "principal", MAX_PRINCIPAL);
  const r = await engine.query<RawAccount>(
    `INSERT INTO connector_accounts (id, source_id, provider, services, principal_ref, account_label, config)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb)
     RETURNING ${ACCOUNT_COLS}`,
    [randomUUID(), input.sourceId, input.provider, [...new Set(input.services)], principal, label, JSON.stringify(input.config ?? {})],
  );
  return toAccount(r.rows[0]!);
}

export async function getAccount(engine: Engine, id: string): Promise<ConnectorAccount | null> {
  // scope: operator-only the sync worker (account id from its own job) and operator routes; a member route lists by source
  const r = await engine.query<RawAccount>(`SELECT ${ACCOUNT_COLS} FROM connector_accounts WHERE id = $1`, [id]);
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export async function findAccount(
  engine: Engine,
  sourceId: string,
  provider: string,
  accountLabel: string,
): Promise<ConnectorAccount | null> {
  const r = await engine.query<RawAccount>(
    `SELECT ${ACCOUNT_COLS} FROM connector_accounts WHERE source_id = $1 AND provider = $2 AND account_label = $3`,
    [sourceId, provider, accountLabel],
  );
  return r.rows[0] ? toAccount(r.rows[0]) : null;
}

export async function listAccounts(engine: Engine, opts: { sourceId?: string } = {}): Promise<ConnectorAccount[]> {
  const r = opts.sourceId === undefined
    // scope: operator-only the admin connectors page and doctor list every account; members pass sourceId
    ? await engine.query<RawAccount>(`SELECT ${ACCOUNT_COLS} FROM connector_accounts ORDER BY created_at, id`)
    : await engine.query<RawAccount>(
      `SELECT ${ACCOUNT_COLS} FROM connector_accounts WHERE source_id = $1 ORDER BY created_at, id`,
      [opts.sourceId],
    );
  return r.rows.map(toAccount);
}

export async function setAccountEnabled(engine: Engine, id: string, enabled: boolean): Promise<boolean> {
  const r = await engine.query(
    `UPDATE connector_accounts SET enabled = $2, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [id, enabled],
  );
  return r.rows.length > 0;
}

export async function setAccountStatus(
  engine: Engine,
  id: string,
  status: ConnectorAccountStatus,
  reason: string | null = null,
): Promise<boolean> {
  if (!CONNECTOR_ACCOUNT_STATUSES.includes(status)) throw new ConnectorAccountError("invalid account status");
  const why = reason === null ? null : cleanLabel(reason, "status reason", MAX_REASON);
  const r = await engine.query(
    `UPDATE connector_accounts SET status = $2, status_reason = $3, updated_at = NOW() WHERE id = $1 RETURNING id`,
    [id, status, why],
  );
  return r.rows.length > 0;
}

/**
 * A refused or revoked token parks the account: sync skips it until the owner
 * reconnects. Its pages, cursors and settings stay where they are.
 */
export function markNeedsReconnect(engine: Engine, id: string, reason: string): Promise<boolean> {
  return setAccountStatus(engine, id, "needs_reconnect", reason);
}

/** Delete an account and, by cascade, its credential. Pages are never touched. */
export async function deleteAccount(engine: Engine, id: string): Promise<boolean> {
  const r = await engine.query(`DELETE FROM connector_accounts WHERE id = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
}

export interface StoredCredential {
  tokens: TokenSet;
  scopes: string[];
  expiresAt: string | null;
}

function parseTokens(text: string): TokenSet {
  const v = JSON.parse(text) as Partial<TokenSet>;
  if (typeof v.access_token !== "string" || v.access_token === "") throw new ConnectorAccountError("stored credential has no access token");
  return {
    access_token: v.access_token,
    ...(typeof v.refresh_token === "string" ? { refresh_token: v.refresh_token } : {}),
    ...(typeof v.token_type === "string" ? { token_type: v.token_type } : {}),
  };
}

/** Seal and store (or replace) an account's tokens. */
export async function storeCredential(
  engine: Engine,
  kek: Kek,
  account: Pick<ConnectorAccount, "id" | "provider">,
  tokens: TokenSet,
  opts: { scopes: readonly string[]; expiresAt: Date | null },
): Promise<void> {
  if (typeof tokens.access_token !== "string" || tokens.access_token === "") {
    throw new ConnectorAccountError("credential has no access token");
  }
  const body = JSON.stringify({
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
  });
  const sealed = seal(kek, body, credentialAad(account.id, account.provider, kek.id));
  await engine.query(
    `INSERT INTO connector_credentials (account_id, kek_id, nonce, ciphertext, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6)
     ON CONFLICT (account_id) DO UPDATE SET
       kek_id = EXCLUDED.kek_id, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext,
       scopes = EXCLUDED.scopes, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
    [account.id, sealed.kek_id, sealed.nonce, sealed.ciphertext, [...opts.scopes], opts.expiresAt?.toISOString() ?? null],
  );
}

/**
 * Decrypt an account's tokens. The AAD is rebuilt from the account row, so a
 * credential copied onto another account does not open.
 */
export async function readCredential(
  engine: Engine,
  keys: Kek | readonly Kek[],
  accountId: string,
  opts: { echo?: EchoDictionary } = {},
): Promise<StoredCredential | null> {
  const r = await engine.query<{
    provider: string;
    kek_id: string;
    nonce: string;
    ciphertext: string;
    scopes: string[];
    expires_at: Date | string | null;
  }>(
    // scope: operator-only the sync worker and operator disconnect open a credential; no member request reads one
    `SELECT a.provider, c.kek_id, c.nonce, c.ciphertext, c.scopes, c.expires_at
       FROM connector_credentials c JOIN connector_accounts a ON a.id = c.account_id
      WHERE c.account_id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const tokens = parseTokens(unseal(keys, row, credentialAad(accountId, row.provider, row.kek_id)));
  if (opts.echo) {
    opts.echo.set(tokens.access_token, "connector-token");
    if (tokens.refresh_token) opts.echo.set(tokens.refresh_token, "connector-token");
  }
  return { tokens, scopes: [...(row.scopes ?? [])], expiresAt: iso(row.expires_at) };
}

export interface CredentialMeta {
  kek_id: string;
  scopes: string[];
  expires_at: string | null;
  rotated_at: string | null;
  updated_at: string;
}

/** What a credential looks like without opening it: safe to show and log. */
export async function credentialMeta(engine: Engine, accountId: string): Promise<CredentialMeta | null> {
  const r = await engine.query<{
    kek_id: string;
    scopes: string[];
    expires_at: Date | string | null;
    rotated_at: Date | string | null;
    updated_at: Date | string;
  }>(
    `SELECT kek_id, scopes, expires_at, rotated_at, updated_at FROM connector_credentials WHERE account_id = $1`,
    [accountId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    kek_id: row.kek_id,
    scopes: [...(row.scopes ?? [])],
    expires_at: iso(row.expires_at),
    rotated_at: iso(row.rotated_at),
    updated_at: iso(row.updated_at)!,
  };
}
