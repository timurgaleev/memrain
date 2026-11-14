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
 * scopes must equal the requested read-only set exactly (anything else is
 * refused and the token revoked), and the account is stored disabled with its
 * tokens sealed. Nothing syncs until the owner enables it.
 *
 * The redirect URI comes from configuration, never from the request. Errors
 * carry a code and a fixed message; provider text, codes and tokens are never
 * echoed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Engine } from "../engine/interface.ts";
import { getSource } from "../sources.ts";
import type { FetchFn } from "./client.ts";
import {
  assertConnectorName,
  cleanLabel,
  createAccount,
  findAccount,
  readCredential,
  setAccountStatus,
  storeCredential,
  type ConnectorAccount,
  type TokenSet,
} from "./accounts.ts";
import { getOAuthClient } from "./oauth-clients.ts";
import type { ConnectorProvider, ProviderRegistry } from "./providers.ts";
import { oauthStateAad, seal, unseal, type Kek } from "./vault.ts";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Consumed and expired states linger this long, then the next start prunes them. */
const STATE_RETENTION_MS = 24 * 60 * 60_000;
const PROVIDER_TIMEOUT_MS = 15_000;
const MAX_PROVIDER_BODY = 64 * 1024;
const MAX_CODE = 2048;
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
  | "state_invalid"
  | "state_used"
  | "state_expired"
  | "state_session"
  | "state_provider"
  | "provider_denied"
  | "code_missing"
  | "token_exchange"
  | "scope_mismatch"
  | "identity"
  | "account_not_found";

const MESSAGES: Record<ConnectErrorCode, string> = {
  connectors_disabled: "connectors are off or the connector key is missing",
  unknown_provider: "unknown connector provider",
  unknown_service: "unknown or empty service list for this provider",
  source_not_found: "source not found",
  source_kind: "this source's kind cannot hold that service",
  redirect_uri: "the connector redirect URI must be https (or http on localhost)",
  no_client: "no OAuth client configured for this provider",
  state_invalid: "unknown connect state",
  state_used: "this connect link was already used",
  state_expired: "this connect link expired; start again",
  state_session: "this connect was started in another admin session",
  state_provider: "this connect was started for another provider",
  provider_denied: "the provider refused the connect",
  code_missing: "the provider returned no authorization code",
  token_exchange: "the provider refused the authorization code",
  scope_mismatch: "the provider granted different scopes than requested; the grant was refused",
  identity: "could not read the connected account's identity",
  account_not_found: "connector account not found",
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

async function resolveClient(deps: ConnectDeps, kek: Kek, provider: string): Promise<{ clientId: string; clientSecret: string }> {
  const stored = await getOAuthClient(deps.engine, kek, provider);
  if (stored) return stored;
  const env = deps.env ?? process.env;
  const key = provider.toUpperCase();
  const clientId = env[`MEMRAIN_${key}_OAUTH_CLIENT_ID`]?.trim() ?? "";
  const clientSecret = env[`MEMRAIN_${key}_OAUTH_CLIENT_SECRET`]?.trim() ?? "";
  if (clientId === "" || clientSecret === "") throw new ConnectError("no_client");
  return { clientId, clientSecret };
}

export interface StartConnectInput {
  provider: string;
  sourceId: string;
  services: readonly string[];
  principalRef: string;
  adminSessionId: string;
  /** From configuration (see connectorCallbackUri), never from the request. */
  redirectUri: string;
}

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
  const client = await resolveClient(deps, kek, provider.id);

  const now = (deps.now ?? Date.now)();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const stateHash = sha256Hex(state);
  const sealed = seal(kek, verifier, oauthStateAad(stateHash, provider.id, kek.id));
  const scopes = requestedScopes(provider, services);
  const expiresAt = new Date(now + OAUTH_STATE_TTL_MS).toISOString();

  await deps.engine.query(`DELETE FROM connector_oauth_states WHERE expires_at < $1`, [new Date(now - STATE_RETENTION_MS).toISOString()]);
  await deps.engine.query(
    `INSERT INTO connector_oauth_states
       (state_hash, provider, source_id, principal_ref, admin_session_hash, kek_id, nonce, pkce_verifier_enc,
        requested_scopes, services, redirect_uri, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::text[], $11, $12, $13)`,
    [stateHash, provider.id, source.id, principal, sessionHash(input.adminSessionId), sealed.kek_id, sealed.nonce,
      sealed.ciphertext, scopes, services, input.redirectUri, new Date(now).toISOString(), expiresAt],
  );

  const url = new URL(provider.authorizeUrl);
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
}

/** Consume a state exactly once, then check what it is bound to. */
async function consumeState(deps: ConnectDeps, state: unknown, provider: string, adminSessionId: string): Promise<StateRow & { stateHash: string }> {
  if (typeof state !== "string" || !STATE_RE.test(state)) throw new ConnectError("state_invalid");
  const stateHash = sha256Hex(state);
  const r = await deps.engine.query<StateRow>(
    `UPDATE connector_oauth_states SET consumed_at = NOW()
      WHERE state_hash = $1 AND consumed_at IS NULL
      RETURNING provider, source_id, principal_ref, admin_session_hash, kek_id, nonce, pkce_verifier_enc,
                requested_scopes, services, redirect_uri, expires_at`,
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
  const text = await res.text();
  if (text.length > MAX_PROVIDER_BODY) return null;
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
  adminSessionId: string;
}

export async function completeConnect(
  deps: ConnectDeps,
  input: CompleteConnectInput,
): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  const kek = requireKek(deps);
  const st = await consumeState(deps, input.state, input.provider, input.adminSessionId);
  const provider = requireProvider(deps, st.provider);
  if (input.error !== undefined && input.error !== null && input.error !== "") {
    const reason = typeof input.error === "string" && /^[a-z_]{1,64}$/.test(input.error) ? input.error : "unknown";
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
    res = await fetch(provider.tokenUrl, {
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
  const body = res.ok ? await readProviderJson(res) : null;
  if (!res.ok || !body) throw new ConnectError("token_exchange", { status: res.status });
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw new ConnectError("token_exchange", { status: res.status });
  const refreshToken = typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : undefined;

  const requested = st.requested_scopes ?? [];
  const granted = parseScopes(provider, body.scope, requested);
  const extra = granted.filter((s) => !requested.includes(s)).sort();
  const missing = requested.filter((s) => !granted.includes(s)).sort();
  if (extra.length > 0 || missing.length > 0) {
    const revoked = await revokeToken(provider, fetch, refreshToken ?? accessToken, client);
    throw new ConnectError("scope_mismatch", { extra, missing, revoked });
  }

  let label: string;
  try {
    label = cleanLabel(await provider.identify({ fetch, accessToken, tokenResponse: body }), "account label", 320);
  } catch {
    await revokeToken(provider, fetch, refreshToken ?? accessToken, client);
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
    return await persistGrant(deps.engine, kek, st, provider.id, label, tokens, scopes, expiresAt);
  } catch (e) {
    // Nothing was stored, so nothing could disconnect this grant later.
    await revokeToken(provider, fetch, refreshToken ?? accessToken, client);
    throw e;
  }
}

async function persistGrant(
  engine: Engine,
  kek: Kek,
  st: StateRow,
  providerId: string,
  label: string,
  tokens: TokenSet,
  scopes: string[],
  expiresAt: Date | null,
): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  return engine.transaction(async (tx) => {
    const existing = await findAccount(tx, st.source_id, providerId, label);
    if (existing) {
      await storeCredential(tx, kek, existing, tokens, { scopes, expiresAt });
      await tx.query(`UPDATE connector_accounts SET services = $2::text[], updated_at = NOW() WHERE id = $1`, [existing.id, st.services]);
      await setAccountStatus(tx, existing.id, "active", null);
      const account = (await findAccount(tx, st.source_id, providerId, label))!;
      return { account, reconnected: true };
    }
    const created = await createAccount(tx, {
      sourceId: st.source_id,
      provider: providerId,
      services: st.services,
      principalRef: st.principal_ref,
      accountLabel: label,
    });
    await storeCredential(tx, kek, created, tokens, { scopes, expiresAt });
    return { account: created, reconnected: false };
  });
}

/**
 * Disconnect an account: revoke its token upstream, then drop the credential
 * and park the account as revoked and disabled. When the provider can revoke
 * but the revocation fails (or the credential cannot be opened), the sealed
 * credential is kept and the account parked as `error`/`revoke_failed`, so a
 * later retry can still revoke it; `force` drops it anyway. A provider with no
 * revocation endpoint has nothing to retry. Pages stay either way; deleting
 * them is a separate, explicit step.
 */
export async function disconnectAccount(
  deps: ConnectDeps,
  accountId: string,
  opts: { force?: boolean } = {},
): Promise<{ revoked: boolean; credentialKept: boolean }> {
  // scope: operator-only disconnect is an operator action on a named account
  const r = await deps.engine.query<{ provider: string }>(`SELECT provider FROM connector_accounts WHERE id = $1`, [accountId]);
  const row = r.rows[0];
  if (!row) throw new ConnectError("account_not_found");
  const provider = deps.providers.get(row.provider);
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
  // Unknown provider: we cannot tell whether a revoke is owed, so keep it too.
  const owesRevoke = hasCredential && (canRevoke || provider === null) && !revoked;
  const keep = owesRevoke && opts.force !== true;
  await deps.engine.transaction(async (tx) => {
    if (!keep) await tx.query(`DELETE FROM connector_credentials WHERE account_id = $1`, [accountId]);
    await tx.query(`UPDATE connector_accounts SET enabled = FALSE, updated_at = NOW() WHERE id = $1`, [accountId]);
    await setAccountStatus(tx, accountId, keep ? "error" : "revoked", keep ? "revoke_failed" : null);
  });
  return { revoked, credentialKept: keep };
}
