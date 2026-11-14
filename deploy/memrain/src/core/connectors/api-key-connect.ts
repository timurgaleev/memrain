/**
 * Connecting a provider that authenticates with an API key the owner pastes
 * (Fireflies). The key is checked against the provider before anything is
 * stored; the provider names the key's owner, and that name is the account
 * label. The key is sealed in the vault like an OAuth token, the account is
 * created disabled, and saving a working key for an existing account (same
 * source, provider and owner) replaces the sealed key and makes it active
 * again, so a paused `needs_reconnect` account resumes from its cursors.
 *
 * The key never leaves this module except toward the provider's own origin
 * and into the vault: errors carry a code, never the key or provider text.
 */
import { getSource } from "../sources.ts";
import { cleanLabel, createAccount, findAccount, setAccountStatus, storeCredential, type ConnectorAccount } from "./accounts.ts";
import type { ConnectDeps } from "./oauth-connect.ts";
import type { ApiKeyProvider } from "./providers.ts";

export type ApiKeyConnectErrorCode =
  | "connectors_disabled"
  | "unknown_provider"
  | "source_not_found"
  | "source_kind"
  | "key_invalid"
  | "key_rejected"
  | "provider_unavailable"
  | "identity";

const MESSAGES: Record<ApiKeyConnectErrorCode, string> = {
  connectors_disabled: "connectors are off or the connector key is missing",
  unknown_provider: "unknown API-key connector provider",
  source_not_found: "source not found",
  source_kind: "this source's kind cannot hold that provider's data",
  key_invalid: "the API key is missing or malformed",
  key_rejected: "the provider refused the API key",
  provider_unavailable: "the provider could not be reached to check the API key; try again",
  identity: "the provider did not say which account the API key belongs to",
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

function keyErrorCode(e: unknown): ApiKeyConnectErrorCode {
  const code = e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return code === "key_rejected" || code === "identity" ? code : "provider_unavailable";
}

export async function connectApiKey(deps: ConnectDeps, input: ApiKeyConnectInput): Promise<{ account: ConnectorAccount; reconnected: boolean }> {
  const kek = deps.kek;
  if (!kek) throw new ApiKeyConnectError("connectors_disabled");
  const provider: ApiKeyProvider | null = deps.providers.getApiKey(input.provider);
  if (!provider) throw new ApiKeyConnectError("unknown_provider");
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
      return { account: (await findAccount(tx, source.id, provider.id, label))!, reconnected: true };
    }
    const created = await createAccount(tx, { sourceId: source.id, provider: provider.id, services, principalRef: principal, accountLabel: label });
    await storeCredential(tx, kek, created, tokens, { scopes: [], expiresAt: null });
    return { account: created, reconnected: false };
  });
}
