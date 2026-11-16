/**
 * The connector provider registry: what the OAuth connect flow needs to know
 * about one provider (Google, Microsoft, Slack, …), and, for a provider that
 * syncs, the API origin its adapter reads from.
 *
 * A provider declares its endpoints, the read-only scopes each service needs
 * and the source kinds each service may feed. The connect flow requests
 * exactly those scopes and refuses a grant that differs from them. Real
 * provider definitions are registered with their connectors; tests register
 * their own provider and play its endpoints with a recorded FetchFn.
 *
 * A provider that authenticates with an API key the owner pastes (Fireflies)
 * is an ApiKeyProvider instead: no OAuth endpoints, a key check that names the
 * key's owner, and a sync whose credential is the sealed key itself. The OAuth
 * connect flow never sees one.
 */
import type { Engine } from "../engine/interface.ts";
import type { FetchFn } from "./client.ts";
import type { ProviderLimiterOptions } from "./limiter.ts";
import { firefliesProvider } from "./fireflies.ts";
import type { SourceKind } from "../sources.ts";
import type { SyncAccount, SyncAdapter } from "./sync-engine.ts";
import { assertConnectorName } from "./accounts.ts";
import { googleProvider } from "./google/provider.ts";
import { microsoftProvider } from "./microsoft/provider.ts";

export interface ProviderService {
  /** Read-only scopes this service needs. */
  scopes: readonly string[];
  /** Source kinds an account of this service may write into. */
  sourceKinds: readonly SourceKind[];
  /** The https origin this service's API answers on, when it is not the provider's `sync.apiOrigin`. */
  apiOrigin?: string;
  /** Minimum gap between two requests of one account to this service, in ms (the client's default otherwise). */
  minSpacingMs?: number;
}

/** Who a token belongs to: the account label and, when it can differ, the mailbox address. */
export interface ProviderIdentity {
  label: string;
  mailbox?: string;
  /**
   * The provider's own id for the user (Graph's `id`): stable when an address
   * is reused or shared, so a reconnect can tell another user from the row's.
   */
  userId?: string;
  /** The provider named no address for the account; the label is a sign-in name or the id. */
  noAddress?: boolean;
}

/** Connect errors a provider can name from its own refusal. */
export type ProviderConnectError = "admin_consent_required" | "consent_declined";

export interface RevokeContext {
  fetch: FetchFn;
  token: string;
  client: { clientId: string; clientSecret: string };
}

/**
 * What a sync run hands its adapter: the run's environment and clock, and the
 * brain's engine for an adapter that reads back what its account stored.
 */
export interface AdapterContext {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  engine?: Engine;
}

export interface ConnectorProvider {
  id: string;
  /** Authorization endpoint the owner's browser is sent to (https). */
  authorizeUrl: string;
  /** Token endpoint, called server to server (https). */
  tokenUrl: string;
  /** RFC 7009 revocation endpoint, when the provider has one (https). */
  revokeUrl?: string;
  /** Scopes every connect asks for, on top of the services' scopes. */
  baseScopes: readonly string[];
  services: Readonly<Record<string, ProviderService>>;
  /** Extra query parameters on the authorization URL. */
  authorizeParams?: Readonly<Record<string, string>>;
  /**
   * The provider folds every scope a user granted this OAuth client into each
   * new grant of it (Google's combined authorization). A connect then also
   * asks for the services the brain's other accounts of this provider still
   * hold, so the grant equals the request and the exact-scope check holds.
   */
  combinedGrants?: boolean;
  /**
   * The provider names a directory tenant in its endpoint paths (Microsoft):
   * `{tenant}` in authorizeUrl and tokenUrl is filled from the OAuth client's
   * tenant, else `default`.
   */
  tenant?: { default: string };
  /**
   * Scopes the provider may leave out of a grant, or add to it, without
   * changing what the grant allows (Microsoft's OpenID Connect scopes). The
   * exact-scope check ignores them on both sides.
   */
  optionalGrantScopes?: readonly string[];
  /**
   * Every new grant carries all the scopes the user already consented to for
   * this client, and Memrain cannot withdraw that consent (Microsoft has no
   * revocation for a delegated grant). A grant may then hold other services'
   * read-only scopes of this provider on top of the request.
   */
  grantIncludesPriorConsent?: boolean;
  /** A clearer connect error for a refused code exchange, read from the provider's error body. */
  tokenErrorCode?: (body: Record<string, unknown>) => ProviderConnectError | null;
  /**
   * A clearer connect error for a refusal sent back to the redirect URI, read
   * from its `error` and `error_description` parameters; anything else is
   * `provider_denied`.
   */
  callbackErrorCode?: (params: { error: string; description: string | null }) => ProviderConnectError | null;
  /** Where the owner withdraws the app's consent, for a provider Memrain cannot revoke at. */
  consentUrls?: readonly string[];
  /** Separator of the token response's `scope` field (a space by default). */
  scopeSeparator?: string;
  /** Map a granted scope onto the spelling that was requested. */
  normalizeScope?: (scope: string) => string;
  /**
   * The mailbox address or workspace name the token belongs to (the account
   * label), or that label with the address mail reaches the account at when
   * the two can differ (stored as the account's MAILBOX_ADDRESS).
   */
  identify: (ctx: { fetch: FetchFn; accessToken: string; tokenResponse: Record<string, unknown> }) => Promise<string | ProviderIdentity>;
  /** Provider-specific revocation; the default posts RFC 7009 to `revokeUrl`. */
  revoke?: (ctx: RevokeContext) => Promise<boolean>;
  /** How an account of this provider syncs; a provider without it can connect but not sync. */
  sync?: {
    /** The one https origin the sync client may call. */
    apiOrigin: string;
    adapter: (account: SyncAccount, ctx: AdapterContext) => SyncAdapter;
  };
}

export interface ApiKeyProvider {
  id: string;
  services: Readonly<Record<string, ProviderService>>;
  /**
   * Check a key with the provider and return who owns it (the account label).
   * Throws when the provider refuses the key or cannot be reached.
   */
  verifyKey(ctx: { fetch: FetchFn; apiKey: string }): Promise<string>;
  sync: {
    /** The one https origin the sync client may call. */
    apiOrigin: string;
    /** Pacing shared by every run of one account (the key's own limits). */
    limits: Omit<ProviderLimiterOptions, "now" | "sleep">;
    adapter: (account: SyncAccount, ctx: { engine: Engine; now: () => number }) => SyncAdapter;
  };
}

function assertHttps(url: string, what: string, id: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`provider ${id}: ${what} is not a URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`provider ${id}: ${what} must be https`);
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`provider ${id}: ${what} must not carry credentials or a fragment`);
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ConnectorProvider>();
  private readonly keyed = new Map<string, ApiKeyProvider>();

  register(provider: ConnectorProvider): void {
    assertConnectorName(provider.id, "provider");
    if (this.providers.has(provider.id) || this.keyed.has(provider.id)) throw new Error(`provider ${provider.id} is already registered`);
    assertTenantEndpoints(provider);
    const endpoints = oauthEndpoints(provider);
    assertHttps(endpoints.authorizeUrl, "authorizeUrl", provider.id);
    assertHttps(endpoints.tokenUrl, "tokenUrl", provider.id);
    if (provider.revokeUrl !== undefined) assertHttps(provider.revokeUrl, "revokeUrl", provider.id);
    if (provider.sync !== undefined) assertHttps(provider.sync.apiOrigin, "sync.apiOrigin", provider.id);
    const services = Object.keys(provider.services);
    if (services.length === 0) throw new Error(`provider ${provider.id} declares no services`);
    for (const s of services) {
      assertConnectorName(s, "service");
      const origin = provider.services[s]!.apiOrigin;
      if (origin !== undefined) assertHttps(origin, `services.${s}.apiOrigin`, provider.id);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): ConnectorProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): ConnectorProvider[] {
    return [...this.providers.values()];
  }

  registerApiKey(provider: ApiKeyProvider): void {
    assertConnectorName(provider.id, "provider");
    if (this.providers.has(provider.id) || this.keyed.has(provider.id)) throw new Error(`provider ${provider.id} is already registered`);
    assertHttps(provider.sync.apiOrigin, "sync.apiOrigin", provider.id);
    const services = Object.keys(provider.services);
    if (services.length === 0) throw new Error(`provider ${provider.id} declares no services`);
    for (const s of services) assertConnectorName(s, "service");
    this.keyed.set(provider.id, provider);
  }

  getApiKey(id: string): ApiKeyProvider | null {
    return this.keyed.get(id) ?? null;
  }

  listApiKey(): ApiKeyProvider[] {
    return [...this.keyed.values()];
  }
}

/** The placeholder a provider's authorize and token URLs carry for the directory (tenant) segment. */
export const TENANT_PLACEHOLDER = "{tenant}";
const TENANT_AUDIENCES = new Set(["common", "organizations", "consumers"]);
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A tenant as it may go into an endpoint path: one of the three audiences
 * (`common`, `organizations`, `consumers`), a directory id, or a verified
 * domain such as `contoso.onmicrosoft.com`
 * (learn.microsoft.com/entra/identity-platform/v2-protocols, "Endpoints").
 * Lower-cased; null for anything else, so no value can add a path segment,
 * a query or another host.
 */
export function normalizeTenant(value: string): string | null {
  const t = value.trim().toLowerCase();
  if (TENANT_AUDIENCES.has(t) || TENANT_ID_RE.test(t)) return t;
  if (t.length > 253) return null;
  const labels = t.split(".");
  return labels.length >= 2 && labels.every((l) => DOMAIN_LABEL_RE.test(l)) ? t : null;
}

/**
 * The authorize and token endpoints for one OAuth client. A provider with a
 * tenant segment takes the client's tenant, else its default; a value that is
 * not a tenant throws rather than reach a URL.
 */
export function oauthEndpoints(provider: ConnectorProvider, tenant?: string | null): { authorizeUrl: string; tokenUrl: string } {
  if (!provider.tenant) return { authorizeUrl: provider.authorizeUrl, tokenUrl: provider.tokenUrl };
  const t = normalizeTenant(tenant ?? provider.tenant.default);
  if (t === null) throw new Error(`provider ${provider.id}: invalid tenant`);
  return { authorizeUrl: provider.authorizeUrl.replace(TENANT_PLACEHOLDER, t), tokenUrl: provider.tokenUrl.replace(TENANT_PLACEHOLDER, t) };
}

function assertTenantEndpoints(provider: ConnectorProvider): void {
  const templated = [provider.authorizeUrl, provider.tokenUrl].some((u) => u.includes(TENANT_PLACEHOLDER));
  if (provider.revokeUrl?.includes(TENANT_PLACEHOLDER)) throw new Error(`provider ${provider.id}: revokeUrl cannot carry a tenant`);
  if (!provider.tenant) {
    if (templated) throw new Error(`provider ${provider.id}: endpoints carry ${TENANT_PLACEHOLDER} but no tenant is declared`);
    return;
  }
  for (const [what, url] of [["authorizeUrl", provider.authorizeUrl], ["tokenUrl", provider.tokenUrl]] as const) {
    if (url.split(TENANT_PLACEHOLDER).length !== 2) throw new Error(`provider ${provider.id}: ${what} must hold ${TENANT_PLACEHOLDER} once, as it declares a tenant`);
  }
  if (normalizeTenant(provider.tenant.default) !== provider.tenant.default) throw new Error(`provider ${provider.id}: default tenant is not a tenant name`);
}

/** Providers that ship with Memrain. Each arrives with its connector. */
export function builtinProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(googleProvider());
  registry.register(microsoftProvider());
  registry.registerApiKey(firefliesProvider());
  return registry;
}
