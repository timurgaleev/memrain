/**
 * Connect a provider account with OAuth 2.0 authorization code + PKCE (S256).
 *
 * start: the signed-in admin picks a provider, services and a source. A random
 * state and PKCE verifier are minted; the database keeps only the state's hash,
 * the hash of the admin session id and the verifier sealed in the vault, for
 * ten minutes. The admin's browser is sent to the provider.
 *
 * complete: the provider redirects back with `code` and `state`. The state is
 * consumed by one conditional UPDATE before anything else, so it works once,
 * whatever happens next. It must belong to the same admin session and the same
 * provider — that stops an attacker from completing a connect with their own
 * code in the victim's session, which would pour the attacker's mailbox into
 * the victim's brain. The code is exchanged server to server, the granted
 * scopes must equal the requested read-only set exactly, or, for a request
 * widened by companion services, exactly the account's own services' scopes
 * (anything else is refused and the token revoked), and the account is stored
 * disabled with its tokens sealed. Nothing syncs until the owner enables it.
 *
 * A refused token is not revoked when that could end a live account's access:
 * for a provider that combines grants, revoking any token of a user's grant
 * revokes all of it. The account label (an email) cannot prove two tokens
 * belong to different users, since a renamed user keeps the grant, so while
 * any live account of that provider exists a refused token is left alone and
 * the connect fails with a `*_not_revoked` code. Nothing is stored either way.
 *
 * The redirect URI comes from configuration, never from the request. Errors
 * carry a code and a fixed message; provider text, codes and tokens are never
 * echoed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { getSource } from "../sources.ts";
import { readTextCapped, type FetchFn } from "./client.ts";
import {
  assertConnectorName,
  cleanLabel,
  createAccount,
  findAccount,
  getAccount,
  markNeedsReconnect,
  readCredential,
  setAccountConfig,
  setAccountStatus,
  storeCredential,
  type ConnectorAccount,
  type TokenSet,
} from "./accounts.ts";
import { MAILBOX_ADDRESS, PROVIDER_USER_ID } from "./model.ts";
import { getOAuthClient } from "./oauth-clients.ts";
import { openNotice, resolveNotice } from "./sync-store.ts";
import { acquireWorkerLock, heartbeatWorkerLock, releaseWorkerLock } from "../jobs/worker-lock.ts";
import { refreshLockId } from "./token-provider.ts";
import { normalizeTenant, oauthEndpoints, type ConnectorProvider, type ProviderRegistry } from "./providers.ts";
import { oauthStateAad, seal, unseal, type Kek } from "./vault.ts";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Consumed and expired states linger this long, then the next start prunes them. */
const STATE_RETENTION_MS = 24 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_BODY = 64 * 1024;
const MAX_CODE = 2048;
const MAX_ERROR_DESCRIPTION = 4096;
const CALLBACK_PATH = "/admin/connectors/callback";
const STATE_RE = /^[\w-]{43}$/;

export type ConnectErrorCode =
  | "connectors_disabled"
  | "unknown_provider"
  | "unknown_service"
  | "source_not_found"
  | "source_kind"
  | "redirect_uri"
  | "no_client"
  | "invalid_tenant"
  | "state_invalid"
  | "state_used"
  | "state_expired"
  | "state_session"
  | "state_provider"
  | "provider_denied"
  | "code_missing"
  | "token_exchange"
  | "scope_mismatch"
  | "scope_mismatch_not_revoked"
  | "identity"
  | "identity_not_revoked"
  | "identity_mismatch"
  | "account_not_found"
  | "refresh_in_progress"
  | "admin_consent_required"
  | "consent_declined";

const MESSAGES: Record<ConnectErrorCode, string> = {
  connectors_disabled: "connectors are off or the connector key is missing",
  unknown_provider: "unknown connector provider",
  unknown_service: "unknown or empty service list for this provider",
  source_not_found: "source not found",
  source_kind: "this source's kind cannot hold that service",
  redirect_uri: "the connector redirect URI must be https (or http on localhost)",
  no_client: "no OAuth client configured for this provider",
  invalid_tenant: "the OAuth client's tenant is not common, organizations, consumers, a directory id or a domain",
  state_invalid: "unknown connect state",
  state_used: "this connect link was already used",
  state_expired: "this connect link expired; start again",
  state_session: "this connect was started in another admin session",
  state_provider: "this connect was started for another provider",
  provider_denied: "the provider refused the connect",
  code_missing: "the provider returned no authorization code",
  token_exchange: "the provider refused the authorization code",
  scope_mismatch: "the provider granted different scopes than requested; the grant was refused",
  scope_mismatch_not_revoked: "the provider granted different scopes than requested; the grant was refused but left in place, because a connected account may share it",
  identity: "could not read the connected account's identity",
  identity_not_revoked: "could not read the connected account's identity; the grant was left in place, because a connected account may share it",
  identity_mismatch: "the account signed in is not the one this account row was connected with; nothing was changed",
  account_not_found: "connector account not found",
  refresh_in_progress: "a worker is renewing this account's token; try the disconnect again shortly",
  admin_consent_required: "the account's organization requires an administrator to approve this app before it can connect",
  consent_declined: "the provider says consent was not given: the owner cancelled, or asked an administrator to approve the app first",
};

export class ConnectError extends Error {
  constructor(readonly code: ConnectErrorCode, readonly detail?: Record<string, unknown>) {
    super(MESSAGES[code]);
    this.name = "ConnectError";
  }
}

export interface ConnectDeps {
  engine: Engine;
  /** The loaded connector key; null keeps connectors closed. */
  kek: Kek | null;
  providers: ProviderRegistry;
  fetch?: FetchFn;
  now?: () => number;
  /** Where `MEMRAIN_<PROVIDER>_OAUTH_CLIENT_ID/_SECRET` are read from. */
  env?: NodeJS.ProcessEnv;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function checkRedirect(uri: string): URL | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash || u.search) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && isLoopback(u.hostname)) return u;
  return null;
}

/** The callback URI for a provider, derived from the configured public origin. */
export function connectorCallbackUri(publicUrl: string, provider: string): string {
  assertConnectorName(provider, "provider");
  let origin = publicUrl;
  while (origin.endsWith("/")) origin = origin.slice(0, -1);
  const base = checkRedirect(origin);
  if (!base) throw new Error("public URL must be https (or http on localhost) to receive connector callbacks");
  return `${base.origin}${CALLBACK_PATH}/${provider}`;
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sessionHash = (id: string) => sha256Hex(`memrain:connector-session\0${id}`);

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function requireKek(deps: ConnectDeps): Kek {
  if (!deps.kek) throw new ConnectError("connectors_disabled");
  return deps.kek;
}

function requireProvider(deps: ConnectDeps, id: string): ConnectorProvider {
  const p = deps.providers.get(id);
  if (!p) throw new ConnectError("unknown_provider");
  return p;
}

function requestedScopes(provider: ConnectorProvider, services: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of [...provider.baseScopes, ...services.flatMap((svc) => provider.services[svc]!.scopes)]) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * For a provider that combines grants: the services, other than `services`,
 * whose every scope a stored credential of this provider holds. A disconnect
 * deletes the credential (and revoking it ends the combined grant at the
 * provider), so only live grants count. In provider order, so the request is
 * stable.
 */
async function heldCompanionServices(engine: Engine, provider: ConnectorProvider, services: readonly string[]): Promise<string[]> {
  if (provider.combinedGrants !== true) return [];
  // scope: operator-only the connect flow reads which scopes this provider's credentials hold, never their contents
  const r = await engine.query<{ scopes: string[] | null }>(
    `SELECT c.scopes FROM connector_credentials c JOIN connector_accounts a ON a.id = c.account_id WHERE a.provider = $1`,
    [provider.id],
  );
  const held = new Set(r.rows.flatMap((row) => row.scopes ?? []));
  return Object.keys(provider.services)
    .filter((s) => !services.includes(s) && provider.services[s]!.scopes.every((scope) => held.has(scope)));
}

export interface ResolvedClient {
  clientId: string;
  clientSecret: string;
  /** The app's tenant; null leaves the provider's default in its endpoints. */
  tenant: string | null;
}

/**
 * The provider's OAuth client: the stored bring-your-own one, else the
 * environment's (`MEMRAIN_<PROVIDER>_OAUTH_CLIENT_ID`, `_SECRET` and, for a
 * provider with tenants, the optional `_TENANT`).
 */
export async function resolveClient(deps: ConnectDeps, kek: Kek, provider: string): Promise<ResolvedClient> {
  const stored = await getOAuthClient(deps.engine, kek, provider);
  if (stored) return stored;
  const env = deps.env ?? process.env;
  const key = provider.toUpperCase();
  const clientId = env[`MEMRAIN_${key}_OAUTH_CLIENT_ID`]?.trim() ?? "";
  const clientSecret = env[`MEMRAIN_${key}_OAUTH_CLIENT_SECRET`]?.trim() ?? "";
  if (clientId === "" || clientSecret === "") throw new ConnectError("no_client");
  const rawTenant = env[`MEMRAIN_${key}_OAUTH_TENANT`]?.trim() ?? "";
  const tenant = rawTenant === "" ? null : normalizeTenant(rawTenant);
  if (rawTenant !== "" && tenant === null) throw new ConnectError("invalid_tenant");
  return { clientId, clientSecret, tenant };
}

/** An OAuth app as its accounts renew with it: the client id and the tenant its endpoints name. Never the secret. */
export interface RenewalApp {
  clientId: string;
  /** As configured; null is the provider's default. */
  tenant: string | null;
}

/** The environment's app (`MEMRAIN_<PROVIDER>_OAUTH_CLIENT_ID`, `_SECRET`, `_TENANT`), or null when its id or secret is unset. */
export function environmentApp(env: NodeJS.ProcessEnv | undefined, provider: string): RenewalApp | null {
  const vars = env ?? process.env;
  const key = provider.toUpperCase();
  const clientId = vars[`MEMRAIN_${key}_OAUTH_CLIENT_ID`]?.trim() ?? "";
  const secret = vars[`MEMRAIN_${key}_OAUTH_CLIENT_SECRET`]?.trim() ?? "";
  if (clientId === "" || secret === "") return null;
  const tenant = vars[`MEMRAIN_${key}_OAUTH_TENANT`]?.trim() ?? "";
  return { clientId, tenant: tenant === "" ? null : tenant };
}

/**
 * The app this provider's accounts renew their tokens with (resolveClient's
 * choice: the stored app, else the environment's), read without opening the
 * secret; null when neither is set.
 */
export async function renewalApp(deps: Pick<ConnectDeps, "engine" | "env">, provider: string): Promise<RenewalApp | null> {
  return (await storedApp(deps.engine, provider)) ?? environmentApp(deps.env, provider);
}

/** The bring-your-own app saved for a provider, without its secret; null when none is. */
export async function storedApp(engine: Engine, provider: string): Promise<RenewalApp | null> {
  const r = await engine.query<{ client_id: string; tenant: string | null }>(
    `SELECT client_id, tenant FROM connector_oauth_clients WHERE provider = $1`,
    [provider],
  );
  return r.rows[0] ? { clientId: r.rows[0].client_id, tenant: r.rows[0].tenant ?? null } : null;
}

/**
 * What going from one app to another does to accounts that renew with the
 * first: `app` when another app (or none) takes over, since a refresh token
 * renews only with the app that issued it; `tenant` when the same app names
 * another tenant, since its endpoints then turn away accounts of another kind
 * (personal ones under `organizations`, work ones under `consumers`) or of
 * another organization; null when nothing changes for them. A tenant left
 * out is the provider's default, so naming the default is no change.
 */
export function renewalChange(provider: ConnectorProvider, before: RenewalApp | null, after: RenewalApp | null): "app" | "tenant" | null {
  if (before === null) return null;
  if (after === null || after.clientId !== before.clientId) return "app";
  if (!provider.tenant) return null;
  return effectiveTenant(provider, before) === effectiveTenant(provider, after) ? null : "tenant";
}

/** The tenant an app's endpoints name: its own, else the provider's default, in canonical form. */
export function effectiveTenant(provider: ConnectorProvider, app: RenewalApp): string | null {
  if (!provider.tenant) return null;
  const raw = app.tenant ?? provider.tenant.default;
  return normalizeTenant(raw) ?? raw.trim().toLowerCase();
}

/**
 * Accounts of a provider that still hold a credential to renew: every status
 * but `revoked`. A refresh token belongs to the app that issued it, so these
 * stop renewing once another app replaces it.
 */
export async function accountsRenewingWith(engine: Engine, provider: string): Promise<number> {
  // scope: operator-only replacing a provider's app is an operator action; it counts accounts, never reads them
  const r = await engine.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM connector_accounts WHERE provider = $1 AND status <> 'revoked'`,
    [provider],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Park a provider's active accounts for a reconnect once the app they renew
 * with was replaced, removed or pointed at another tenant: their tokens may no
 * longer renew, and a sync would
 * otherwise run on until the current access token expires and then fail
 * with whatever the provider answers. Each gets the needs_reconnect notice a
 * reconnect resolves. Returns how many were parked.
 */
export async function parkAccountsForReconnect(engine: Engine, provider: string, change: "app" | "tenant" | "remove" = "app"): Promise<number> {
  const what = { app: "was replaced", tenant: "names another tenant", remove: "was removed" }[change];
  // scope: operator-only replacing a provider's app is an operator action on all of its accounts
  const r = await engine.query<{ id: string; source_id: string }>(
    `SELECT id, source_id FROM connector_accounts WHERE provider = $1 AND status = 'active'`,
    [provider],
  );
  let parked = 0;
  for (const a of r.rows) {
    if (!(await markNeedsReconnect(engine, a.id, `the OAuth app ${what}; reconnect the account`))) continue;
    await openNotice(engine, a.id, "needs_reconnect",
      `${provider} account for source '${a.source_id}' needs a reconnect: its OAuth app ${what}, so sync is paused; its data and cursors are kept`);
    parked++;
  }
  return parked;
}

export interface StartConnectInput {
  provider: string;
  sourceId: string;
  services: readonly string[];
  principalRef: string;
  adminSessionId: string;
  /** From configuration (see connectorCallbackUri), never from the request. */
  redirectUri: string;
  /**
   * A Reconnect on an account row: the callback renews that row only, and
   * refuses a grant for any other account instead of adding it to the source.
   */
  accountId?: string;
}

const ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startConnect(deps: ConnectDeps, input: StartConnectInput): Promise<{ authorizeUrl: string; expiresAt: string }> {
  const kek = requireKek(deps);
  const provider = requireProvider(deps, input.provider);
  const services = [...new Set(input.services)];
  if (services.length === 0 || services.some((s) => !Object.hasOwn(provider.services, s))) {
    throw new ConnectError("unknown_service");
  }
  if (typeof input.adminSessionId !== "string" || input.adminSessionId === "") throw new ConnectError("state_session");
  if (!checkRedirect(input.redirectUri)) throw new ConnectError("redirect_uri");
  const principal = cleanLabel(input.principalRef, "principal", 200);
  const source = await getSource(deps.engine, input.sourceId);
  if (!source) throw new ConnectError("source_not_found");
  if (services.some((s) => !provider.services[s]!.sourceKinds.includes(source.kind))) throw new ConnectError("source_kind");
  let accountId: string | null = null;
  if (input.accountId !== undefined) {
    const account = ACCOUNT_ID_RE.test(input.accountId) ? await getAccount(deps.engine, input.accountId) : null;
    if (!account || account.provider !== provider.id || account.source_id !== source.id) throw new ConnectError("account_not_found");
    accountId = account.id;
  }
  const client = await resolveClient(deps, kek, provider.id);
  const companions = await heldCompanionServices(deps.engine, provider, services);

  const now = (deps.now ?? Date.now)();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateHash = sha256Hex(state);
  const sealed = seal(kek, verifier, oauthStateAad(stateHash, provider.id, kek.id));
  const scopes = requestedScopes(provider, Object.keys(provider.services).filter((s) => services.includes(s) || companions.includes(s)));
  const expiresAt = new Date(now + OAUTH_STATE_TTL_MS).toISOString();

  await deps.engine.query(`DELETE FROM connector_oauth_states WHERE expires_at < $1`, [new Date(now - STATE_RETENTION_MS).toISOString()]);
  await deps.engine.query(
    `INSERT INTO connector_oauth_states
       (state_hash, provider, source_id, principal_ref, admin_session_hash, kek_id, nonce, pkce_verifier_enc,
        requested_scopes, services, redirect_uri, created_at, expires_at, account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12, $13, $14)`,
    [stateHash, provider.id, source.id, principal, sessionHash(input.adminSessionId), sealed.kek_id, sealed.nonce,
      sealed.ciphertext, scopes, services, input.redirectUri, new Date(now).toISOString(), expiresAt, accountId],
  );

  const url = new URL(oauthEndpoints(provider, client.tenant).authorizeUrl);
  for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(k, v);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString(), expiresAt };
}

interface StateRow {
  provider: string;
  source_id: string;
  principal_ref: string;
  admin_session_hash: string;
  kek_id: string;
  nonce: string;
  pkce_verifier_enc: string;
  requested_scopes: string[];
  services: string[];
  redirect_uri: string;
  expires_at: Date | string;
  /** The row a Reconnect is for; null for a first connect. */
  account_id: string | null;
}

/** Consume a state exactly once, then check what it is bound to. */
async function consumeState(deps: ConnectDeps, state: unknown, provider: string, adminSessionId: string): Promise<StateRow & { stateHash: string }> {
  if (typeof state !== "string" || !STATE_RE.test(state)) throw new ConnectError("state_invalid");
  const stateHash = sha256Hex(state);
  const r = await deps.engine.query<StateRow>(
    `UPDATE connector_oauth_states SET consumed_at = NOW()
      WHERE state_hash = $1 AND consumed_at IS NULL
      RETURNING provider, source_id, principal_ref, admin_session_hash, kek_id, nonce, pkce_verifier_enc,
                requested_scopes, services, redirect_uri, expires_at, account_id`,
    [stateHash],
  );
  const row = r.rows[0];
  if (!row) {
    // scope: operator-only admin connect callback; the state hash is the capability and was bound to the session
    const seen = await deps.engine.query(`SELECT 1 FROM connector_oauth_states WHERE state_hash = $1`, [stateHash]);
    throw new ConnectError(seen.rows.length > 0 ? "state_used" : "state_invalid");
  }
  const expires = (row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)).getTime();
  if (expires <= (deps.now ?? Date.now)()) throw new ConnectError("state_expired");
  if (typeof adminSessionId !== "string" || adminSessionId === "" || !sameHash(row.admin_session_hash, sessionHash(adminSessionId))) {
    throw new ConnectError("state_session");
  }
  if (row.provider !== provider) throw new ConnectError("state_provider");
  return { ...row, stateHash };
}

async function readProviderJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await readTextCapped(res, MAX_PROVIDER_BODY);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function revokeToken(
  provider: ConnectorProvider,
  fetch: FetchFn,
  token: string,
  client: { clientId: string; clientSecret: string },
): Promise<boolean> {
  try {
    if (provider.revoke) return await provider.revoke({ fetch, token, client });
    if (!provider.revokeUrl) return false;
    const res = await fetch(provider.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ token, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whether revoking a new token could end a live account's access. Only a
 * provider that combines grants shares one grant across accounts; there every
 * token of one user's grant revokes all of it, and the stored label (an email)
 * cannot rule out that a live account is the same user under a changed
 * address. Any status but `revoked` is live: an account parked on an error may
 * still hold a working credential.
 */
async function sharesLiveGrant(engine: Engine, provider: ConnectorProvider): Promise<boolean> {
  if (provider.combinedGrants !== true) return false;
  // scope: operator-only the connect flow asks whether this provider has any live account, never what it holds
  const r = await engine.query(`SELECT 1 FROM connector_accounts WHERE provider = $1 AND status <> 'revoked' LIMIT 1`, [provider.id]);
  return r.rows.length > 0;
}

interface Identified {
  label: string;
  mailbox: string | null;
  userId: string | null;
  noAddress: boolean;
}

/** Who the provider names for a token, or null when it cannot be read. */
async function identifyAccount(
  provider: ConnectorProvider,
  fetch: FetchFn,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Identified | null> {
  try {
    const who = await provider.identify({ fetch, accessToken, tokenResponse: body });
    if (typeof who === "string") return { label: cleanLabel(who, "account label", 320), mailbox: null, userId: null, noAddress: false };
    return {
      label: cleanLabel(who.label, "account label", 320),
      mailbox: who.mailbox === undefined ? null : cleanLabel(who.mailbox, "mailbox address", 320).toLowerCase(),
      userId: who.userId === undefined ? null : cleanLabel(who.userId, "user id", 200),
      noAddress: who.noAddress === true,
    };
  } catch {
    return null;
  }
}

function parseScopes(provider: ConnectorProvider, raw: unknown, requested: readonly string[]): string[] {
  // RFC 6749 §5.1: an omitted scope means the grant is exactly the request.
  if (raw === undefined || raw === null) return [...requested];
  if (typeof raw !== "string") return [];
  const sep = provider.scopeSeparator ?? " ";
  const norm = provider.normalizeScope ?? ((s: string) => s);
  return [...new Set(raw.split(sep).map((s) => s.trim()).filter((s) => s !== "").map(norm))];
}

export interface CompleteConnectInput {
  /** The provider named in the callback path. */
  provider: string;
  state: unknown;
  code?: unknown;
  /** The provider's `error` parameter, when the owner declined. */
  error?: unknown;
  /** The provider's `error_description`, read only by the provider's own callbackErrorCode; never stored or echoed. */
  errorDescription?: unknown;
  adminSessionId: string;
}

export async function completeConnect(
  deps: ConnectDeps,
  input: CompleteConnectInput,
): Promise<{ account: ConnectorAccount; reconnected: boolean; noAddress: boolean }> {
  const kek = requireKek(deps);
  const st = await consumeState(deps, input.state, input.provider, input.adminSessionId);
  const provider = requireProvider(deps, st.provider);
  if (input.error !== undefined && input.error !== null && input.error !== "") {
    const reason = typeof input.error === "string" && /^[a-z_]{1,64}$/.test(input.error) ? input.error : "unknown";
    const description = typeof input.errorDescription === "string" ? input.errorDescription.slice(0, MAX_ERROR_DESCRIPTION) : null;
    const named = provider.callbackErrorCode?.({ error: reason, description }) ?? null;
    if (named !== null) throw new ConnectError(named, { error: reason });
    throw new ConnectError("provider_denied", { error: reason });
  }
  if (typeof input.code !== "string" || input.code === "" || input.code.length > MAX_CODE || !/^[\x21-\x7E]+$/.test(input.code)) {
    throw new ConnectError("code_missing");
  }
  const client = await resolveClient(deps, kek, provider.id);
  const verifier = unseal(kek, { kek_id: st.kek_id, nonce: st.nonce, ciphertext: st.pkce_verifier_enc },
    oauthStateAad(st.stateHash, provider.id, st.kek_id));
  const fetch = deps.fetch ?? (globalThis.fetch as FetchFn);

  let res: Response;
  try {
    res = await fetch(oauthEndpoints(provider, client.tenant).tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: st.redirect_uri,
        code_verifier: verifier,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectError("token_exchange", { status: 0 });
  }
  const body = await readProviderJson(res).catch(() => null);
  if (!res.ok) {
    // The provider may say why (a work tenant that needs an admin's approval); only its own mapping is trusted.
    if (body && provider.tokenErrorCode?.(body) === "admin_consent_required") throw new ConnectError("admin_consent_required", { status: res.status });
    throw new ConnectError("token_exchange", { status: res.status });
  }
  if (!body) throw new ConnectError("token_exchange", { status: res.status });
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw new ConnectError("token_exchange", { status: res.status });
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined;

  const requested = st.requested_scopes ?? [];
  // A grant that asked for offline access but came back without a refresh
  // token would stop syncing within the hour; refuse it instead of storing it.
  if (requested.includes("offline_access") && refreshToken === undefined) throw new ConnectError("token_exchange", { status: res.status, refresh_token: false });
  const granted = parseScopes(provider, body.scope, requested);
  const optional = new Set(provider.optionalGrantScopes ?? []);
  // Scopes of this provider's services the user consented to earlier, which a grant may carry along.
  const consented = new Set(provider.grantIncludesPriorConsent === true ? Object.values(provider.services).flatMap((s) => s.scopes) : []);
  const extra = granted.filter((s) => !requested.includes(s) && !optional.has(s) && !consented.has(s)).sort();
  const missing = requested.filter((s) => !granted.includes(s) && !optional.has(s)).sort();
  // A request widened by companion services (combinedGrants) may also come
  // back as exactly what the account's own services need: another Google
  // user, whose calendar is not connected here, unticks the calendar box.
  const own = requestedScopes(provider, (st.services ?? []).filter((s) => Object.hasOwn(provider.services, s)));
  const exactlyOwn = granted.length === own.length && own.every((s) => granted.includes(s));
  const revoke = () => revokeToken(provider, fetch, refreshToken ?? accessToken, client);
  // A refused token is kept away from revocation when a live account shares its grant.
  const sharedWithLive = async (): Promise<boolean> => {
    if (!(await sharesLiveGrant(deps.engine, provider))) return false;
    console.warn(`[connectors] ${provider.id} connect refused; the new token was not revoked because a live account shares its grant`);
    return true;
  };

  if ((extra.length > 0 || missing.length > 0) && !exactlyOwn) {
    if (await sharedWithLive()) throw new ConnectError("scope_mismatch_not_revoked", { extra, missing, revoked: false });
    throw new ConnectError("scope_mismatch", { extra, missing, revoked: await revoke() });
  }

  const who = await identifyAccount(provider, fetch, accessToken, body);
  if (who === null) {
    if (await sharedWithLive()) throw new ConnectError("identity_not_revoked");
    await revoke();
    throw new ConnectError("identity");
  }

  const now = (deps.now ?? Date.now)();
  const expiresIn = Number(body.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000) : null;
  const tokens: TokenSet = {
    access_token: accessToken,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(typeof body.token_type === "string" ? { token_type: body.token_type } : {}),
  };
  const scopes = [...granted].sort();

  try {
    const config = {
      ...(who.mailbox === null ? {} : { [MAILBOX_ADDRESS]: who.mailbox }),
      ...(who.userId === null ? {} : { [PROVIDER_USER_ID]: who.userId }),
    };
    return { ...await persistGrant(deps.engine, kek, st, provider.id, who.label, config, tokens, scopes, expiresAt), noAddress: who.noAddress };
  } catch (e) {
    // Nothing was stored, so nothing could disconnect this grant later.
    if (!(await sharedWithLive().catch(() => true))) await revoke();
    throw e;
  }
}

async function persistGrant(
  engine: Engine,
  kek: Kek,
  st: StateRow,
  providerId: string,
  label: string,
  /** Identity settings the grant names (the mailbox address, the provider's user id), written on every connect. */
  config: Record<string, unknown>,
  tokens: TokenSet,
  scopes: string[],
  expiresAt: Date | null,
): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  return engine.transaction(async (tx) => {
    const existing = st.account_id === null ? await findAccount(tx, st.source_id, providerId, label) : await getAccount(tx, st.account_id);
    if (st.account_id !== null && existing === null) throw new ConnectError("account_not_found");
    const stored = existing?.config[PROVIDER_USER_ID];
    // A Reconnect renews its own row: an account signed in under another
    // address would otherwise be added to the row's source beside it. The
    // same provider user under a new address is the row's, and keeps the
    // row's label, so its pages keep their names.
    const sameUser = typeof stored === "string" && stored === config[PROVIDER_USER_ID];
    if (st.account_id !== null && existing!.account_label !== label && !sameUser) throw new ConnectError("identity_mismatch");
    // The same address can belong to two users (a personal account made with a
    // work address): a reconnect by another user than the row's changes nothing.
    if (typeof stored === "string" && typeof config[PROVIDER_USER_ID] === "string" && stored !== config[PROVIDER_USER_ID]) {
      throw new ConnectError("identity_mismatch");
    }
    if (existing) {
      await storeCredential(tx, kek, existing, tokens, { scopes, expiresAt });
      await tx.query(`UPDATE connector_accounts SET services = $2::text[], updated_at = NOW() WHERE id = $1`, [existing.id, st.services]);
      if (Object.keys(config).length > 0) await setAccountConfig(tx, existing.id, config);
      await setAccountStatus(tx, existing.id, "active", null);
      // The new grant answers the sync engine's reconnect notice; with sync off no run would.
      await resolveNotice(tx, existing.id, "needs_reconnect");
      const account = (await getAccount(tx, existing.id))!;
      return { account, reconnected: true };
    }
    const created = await createAccount(tx, {
      sourceId: st.source_id,
      provider: providerId,
      services: st.services,
      principalRef: st.principal_ref,
      accountLabel: label,
      config,
    });
    await storeCredential(tx, kek, created, tokens, { scopes, expiresAt });
    return { account: created, reconnected: false };
  });
}

/** How long a disconnect waits for a token refresh in flight; the refresh lock outlives a provider call. */
const DISCONNECT_WAIT_MS = 30_000;
const DISCONNECT_LOCK_TTL_SEC = 60;
const DISCONNECT_POLL_MS = 250;
const DISCONNECT_HEARTBEAT_MS = 15_000;

/**
 * Disconnect an account: revoke its token upstream, then drop the credential
 * and park the account as revoked and disabled. When the provider can revoke
 * but the revocation fails (or the credential cannot be opened), the sealed
 * credential is kept and the account parked as `error`/`revoke_failed`, so a
 * later retry can still revoke it; `force` drops it anyway. A provider with no
 * revocation endpoint has nothing to retry. Pages stay either way; deleting
 * them is a separate, explicit step.
 *
 * The whole disconnect holds the account's refresh lock. A provider that
 * rotates refresh tokens retires the old one on every renewal, so a revoke
 * sent while a refresh is in flight would revoke the dead token and leave the
 * rotated one live at the provider. Waiting for the refresh lets the
 * disconnect read, and revoke, whatever the refresh stored. The lock is
 * renewed while the revoke runs; if it was lost all the same, a refresh may
 * have rotated the token after it was read, so the revoke is not trusted and
 * the credential is kept for a retry.
 */
export async function disconnectAccount(
  deps: ConnectDeps,
  accountId: string,
  opts: { force?: boolean; waitMs?: number } = {},
): Promise<{ revoked: boolean; credentialKept: boolean }> {
  // scope: operator-only disconnect is an operator action on a named account
  const r = await deps.engine.query<{ provider: string }>(`SELECT provider FROM connector_accounts WHERE id = $1`, [accountId]);
  const row = r.rows[0];
  if (!row) throw new ConnectError("account_not_found");
  const lockId = refreshLockId(accountId);
  const holder = `disconnect:${crypto.randomUUID()}`;
  const waitMs = opts.waitMs ?? DISCONNECT_WAIT_MS;
  for (let waited = 0; !(await acquireWorkerLock(deps.engine, lockId, holder, DISCONNECT_LOCK_TTL_SEC)); waited += DISCONNECT_POLL_MS) {
    if (waited >= waitMs) throw new ConnectError("refresh_in_progress");
    await new Promise((resolve) => setTimeout(resolve, DISCONNECT_POLL_MS));
  }
  let lost = false;
  const stillHeld = async (via: Engine = deps.engine): Promise<boolean> => {
    if (!lost && !(await heartbeatWorkerLock(via, lockId, holder))) lost = true;
    return !lost;
  };
  const beat = setInterval(() => void stillHeld().catch(() => { lost = true; }), DISCONNECT_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await disconnectLocked(deps, accountId, row.provider, opts.force === true, stillHeld);
  } finally {
    clearInterval(beat);
    await releaseWorkerLock(deps.engine, lockId, holder);
  }
}

async function disconnectLocked(
  deps: ConnectDeps,
  accountId: string,
  providerId: string,
  force: boolean,
  /** Renews the lock through `via`; false once it was lost. */
  stillHeld: (via?: Engine) => Promise<boolean>,
): Promise<{ revoked: boolean; credentialKept: boolean }> {
  const provider = deps.providers.get(providerId);
  const hasCredential = (await deps.engine.query(`SELECT 1 FROM connector_credentials WHERE account_id = $1`, [accountId])).rows.length > 0;
  const canRevoke = provider !== null && (provider.revoke !== undefined || provider.revokeUrl !== undefined);
  let revoked = false;
  if (hasCredential && canRevoke && deps.kek) {
    const cred = await readCredential(deps.engine, deps.kek, accountId).catch(() => null);
    const client = cred ? await resolveClient(deps, deps.kek, provider.id).catch(() => null) : null;
    if (cred && client) {
      revoked = await revokeToken(provider, deps.fetch ?? (globalThis.fetch as FetchFn), cred.tokens.refresh_token ?? cred.tokens.access_token, client);
    }
  }
  return deps.engine.transaction(async (tx) => {
    // Renewed inside the transaction, the lock row stays locked until the
    // credential is gone. Lost, the revoked token may already have been
    // rotated away, so the revoke is not trusted.
    if (revoked && !(await stillHeld(tx))) revoked = false;
    // Unknown provider: we cannot tell whether a revoke is owed, so keep it too.
    // An API key has nothing to revoke here; the owner retires it at the provider.
    const unknown = provider === null && deps.providers.getApiKey(providerId) === null;
    const owesRevoke = hasCredential && (canRevoke || unknown) && !revoked;
    const keep = owesRevoke && !force;
    if (!keep) await tx.query(`DELETE FROM connector_credentials WHERE account_id = $1`, [accountId]);
    await tx.query(`UPDATE connector_accounts SET enabled = FALSE, updated_at = NOW() WHERE id = $1`, [accountId]);
    await setAccountStatus(tx, accountId, keep ? "error" : "revoked", keep ? "revoke_failed" : null);
    return { revoked, credentialKept: keep };
  });
}
