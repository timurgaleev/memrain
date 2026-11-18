/**
 * Connecting a provider that authenticates with an API key the owner pastes
 * (Fireflies). The key is checked against the provider before anything is
 * stored; the provider names the key's owner, and that name is the account
 * label. The key is sealed in the vault like an OAuth token, the account is
 * created disabled, and saving a working key for an existing account (same
 * source, provider and owner) replaces the sealed key and makes it active
 * again, so a paused `needs_reconnect` account resumes from its cursors.
 *
 * An OAuth provider that also takes a pasted token (Slack's internal-app bot
 * token) goes through the same path: the provider checks the token, names
 * the workspace and the scopes it holds, and a token that can do more than
 * the provider's read-only services is refused. Such an account is marked
 * PASTED_TOKEN: it syncs with the token as it is, with no OAuth app.
 *
 * The key never leaves this module except toward the provider's own origin
 * and into the vault: errors carry a code, never the key or provider text.
 */
import { getSource } from "../sources.ts";
import { cleanLabel, createAccount, findAccount, setAccountConfig, setAccountStatus, storeCredential, type ConnectorAccount } from "./accounts.ts";
import { PASTED_TOKEN, PROVIDER_USER_ID } from "./model.ts";
import type { ConnectDeps } from "./oauth-connect.ts";
import type { ApiKeyProvider, ConnectorProvider, PastedTokenGrant } from "./providers.ts";
import { resolveNotice } from "./sync-store.ts";

export type ApiKeyConnectErrorCode =
  | "connectors_disabled"
  | "unknown_provider"
  | "source_not_found"
  | "source_kind"
  | "key_invalid"
  | "key_rejected"
  | "provider_unavailable"
  | "identity"
  | "scope_mismatch"
  | "identity_mismatch";

const MESSAGES: Record<ApiKeyConnectErrorCode, string> = {
  connectors_disabled: "connectors are off or the connector key is missing",
  unknown_provider: "unknown API-key connector provider",
  source_not_found: "source not found",
  source_kind: "this source's kind cannot hold that provider's data",
  key_invalid: "the API key is missing or malformed",
  key_rejected: "the provider refused the API key",
  provider_unavailable: "the provider could not be reached to check the API key; try again",
  identity: "the provider did not say which account the API key belongs to",
  scope_mismatch: "the token may do more than read, or lacks a scope reading needs; it was not stored",
  identity_mismatch: "an account of that name in this source belongs to another workspace",
};

export class ApiKeyConnectError extends Error {
  constructor(readonly code: ApiKeyConnectErrorCode) {
    super(MESSAGES[code]);
    this.name = "ApiKeyConnectError";
  }
}

/** Printable ASCII without spaces: what every provider key looks like, and nothing a header could be split on. */
const KEY_RE = /^[\x21-\x7E]{16,512}$/;

export interface ApiKeyConnectInput {
  provider: string;
  sourceId: string;
  apiKey: unknown;
  principalRef: string;
}

function keyErrorCode(e: unknown, allowed: readonly ApiKeyConnectErrorCode[] = ["key_rejected", "identity"]): ApiKeyConnectErrorCode {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return allowed.includes(code as ApiKeyConnectErrorCode) ? code as ApiKeyConnectErrorCode : "provider_unavailable";
}

export async function connectApiKey(deps: ConnectDeps, input: ApiKeyConnectInput): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  const kek = deps.kek;
  if (!kek) throw new ApiKeyConnectError("connectors_disabled");
  const provider: ApiKeyProvider | null = deps.providers.getApiKey(input.provider);
  if (!provider) {
    const oauth = deps.providers.get(input.provider);
    if (oauth?.pastedToken) return connectPastedToken(deps, oauth, input);
    throw new ApiKeyConnectError("unknown_provider");
  }
  const source = await getSource(deps.engine, input.sourceId);
  if (!source) throw new ApiKeyConnectError("source_not_found");
  const services = Object.keys(provider.services);
  if (services.some(s => !provider.services[s]!.sourceKinds.includes(source.kind))) throw new ApiKeyConnectError("source_kind");
  if (typeof input.apiKey !== "string" || !KEY_RE.test(input.apiKey)) throw new ApiKeyConnectError("key_invalid");
  const apiKey = input.apiKey;
  const principal = cleanLabel(input.principalRef, "principal", 200);

  let owner: string;
  try {
    owner = await provider.verifyKey({ fetch: deps.fetch ?? (globalThis.fetch as NonNullable<ConnectDeps["fetch"]>), apiKey });
  } catch (e) {
    throw new ApiKeyConnectError(keyErrorCode(e));
  }
  let label: string;
  try {
    label = cleanLabel(owner, "account label", 320);
  } catch {
    throw new ApiKeyConnectError("identity");
  }

  const tokens = { access_token: apiKey };
  return deps.engine.transaction(async (tx) => {
    const existing = await findAccount(tx, source.id, provider.id, label);
    if (existing) {
      await storeCredential(tx, kek, existing, tokens, { scopes: [], expiresAt: null });
      await setAccountStatus(tx, existing.id, "active", null);
      // The new grant answers the sync engine's reconnect notice; with sync off no run would.
      await resolveNotice(tx, existing.id, "needs_reconnect");
      return { account: (await findAccount(tx, source.id, provider.id, label))!, reconnected: true };
    }
    const created = await createAccount(tx, { sourceId: source.id, provider: provider.id, services, principalRef: principal, accountLabel: label });
    await storeCredential(tx, kek, created, tokens, { scopes: [], expiresAt: null });
    return { account: created, reconnected: false };
  });
}

/**
 * Store a token the owner pasted for an OAuth provider that takes one. The
 * account's services are the ones the token's scopes cover; a reconnect with
 * a new token for the same workspace replaces the sealed one and resumes.
 */
async function connectPastedToken(deps: ConnectDeps, provider: ConnectorProvider, input: ApiKeyConnectInput): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  const kek = deps.kek!;
  const source = await getSource(deps.engine, input.sourceId);
  if (!source) throw new ApiKeyConnectError("source_not_found");
  if (typeof input.apiKey !== "string" || !KEY_RE.test(input.apiKey)) throw new ApiKeyConnectError("key_invalid");
  const token = input.apiKey;
  const principal = cleanLabel(input.principalRef, "principal", 200);

  let grant: PastedTokenGrant;
  try {
    grant = await provider.pastedToken!.verify({ fetch: deps.fetch ?? (globalThis.fetch as NonNullable<ConnectDeps["fetch"]>), token });
  } catch (e) {
    throw new ApiKeyConnectError(keyErrorCode(e, ["key_invalid", "key_rejected", "identity", "scope_mismatch"]));
  }
  const services = grant.services.filter(s => Object.hasOwn(provider.services, s));
  if (services.length === 0) throw new ApiKeyConnectError("scope_mismatch");
  if (services.some(s => !provider.services[s]!.sourceKinds.includes(source.kind))) throw new ApiKeyConnectError("source_kind");
  let label: string;
  try {
    label = cleanLabel(grant.identity.label, "account label", 320);
  } catch {
    throw new ApiKeyConnectError("identity");
  }
  const userId = grant.identity.userId === undefined ? null : grant.identity.userId;
  const config = { [PASTED_TOKEN]: true, ...(userId === null ? {} : { [PROVIDER_USER_ID]: userId }) };
  const tokens = { access_token: token };
  return deps.engine.transaction(async (tx) => {
    const existing = await findAccount(tx, source.id, provider.id, label);
    if (existing) {
      const stored = existing.config[PROVIDER_USER_ID];
      if (typeof stored === "string" && userId !== null && stored !== userId) throw new ApiKeyConnectError("identity_mismatch");
      await storeCredential(tx, kek, existing, tokens, { scopes: grant.scopes, expiresAt: null });
      await tx.query(`UPDATE connector_accounts SET services = $2::text[], updated_at = NOW() WHERE id = $1`, [existing.id, services]);
      await setAccountConfig(tx, existing.id, config);
      await setAccountStatus(tx, existing.id, "active", null);
      await resolveNotice(tx, existing.id, "needs_reconnect");
      return { account: (await findAccount(tx, source.id, provider.id, label))!, reconnected: true };
    }
    const created = await createAccount(tx, { sourceId: source.id, provider: provider.id, services, principalRef: principal, accountLabel: label, config });
    await storeCredential(tx, kek, created, tokens, { scopes: grant.scopes, expiresAt: null });
    return { account: created, reconnected: false };
  });
}
