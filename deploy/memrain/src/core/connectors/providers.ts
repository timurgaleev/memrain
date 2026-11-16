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
import { microsoftProvider, microsoftTenant } from "./microsoft/provider.ts";

export interface ProviderService {
  /** Read-only scopes this service needs. */
  scopes: readonly string[];
  /** Source kinds an account of this service may write into. */
  sourceKinds: readonly SourceKind[];
  /** The https origin this service's API answers on, when it is not the provider's `sync.apiOrigin`. */
  apiOrigin?: string;
  /** Minimum gap between two requests of one account to this service, in ms (the client's default otherwise). */
  minSpacingMs?: number;
  /** Request headers every API call of this service carries (Graph's `Prefer`). */
  headers?: Readonly<Record<string, string>>;
}

export interface RevokeContext {
  fetch: FetchFn;
  token: string;
  client: { clientId: string; clientSecret: string };
}

/** What a sync run hands its adapter: the run's environment and clock. */
export interface AdapterContext {
  env: NodeJS.ProcessEnv;
  now?: () => number;
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
  /** Separator of the token response's `scope` field (a space by default). */
  scopeSeparator?: string;
  /** Map a granted scope onto the spelling that was requested. */
  normalizeScope?: (scope: string) => string;
  /**
   * Scopes the token response's `scope` may leave out or add (Microsoft's
   * OpenID scopes): asking for them is not checked against the grant.
   */
  unreportedScopes?: readonly string[];
  /** The mailbox address or workspace name the token belongs to. */
  identify: (ctx: { fetch: FetchFn; accessToken: string; tokenResponse: Record<string, unknown> }) => Promise<string>;
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
    assertHttps(provider.authorizeUrl, "authorizeUrl", provider.id);
    assertHttps(provider.tokenUrl, "tokenUrl", provider.id);
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

let badTenantWarned = false;

/**
 * Providers that ship with Memrain. Each arrives with its connector. A
 * MEMRAIN_MICROSOFT_TENANT that names no tenant leaves Microsoft out, said
 * once on stderr, rather than stopping the server.
 */
export function builtinProviders(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(googleProvider());
  const tenant = microsoftTenant(env);
  if (tenant !== null) registry.register(microsoftProvider(tenant));
  else if (!badTenantWarned) {
    badTenantWarned = true;
    console.error("[connectors] MEMRAIN_MICROSOFT_TENANT is not common, organizations, consumers, a tenant id or a domain; Microsoft is not offered");
  }
  registry.registerApiKey(firefliesProvider());
  return registry;
}
