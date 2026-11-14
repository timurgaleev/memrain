/**
 * The connector provider registry: what the OAuth connect flow needs to know
 * about one provider (Google, Microsoft, Slack, …) and nothing more.
 *
 * A provider declares its endpoints, the read-only scopes each service needs
 * and the source kinds each service may feed. The connect flow requests
 * exactly those scopes and refuses a grant that differs from them. Real
 * provider definitions are registered with their connectors; tests register
 * their own provider and play its endpoints with a recorded FetchFn.
 */
import type { FetchFn } from "./client.ts";
import type { SourceKind } from "../sources.ts";
import { assertConnectorName } from "./accounts.ts";

export interface ProviderService {
  /** Read-only scopes this service needs. */
  scopes: readonly string[];
  /** Source kinds an account of this service may write into. */
  sourceKinds: readonly SourceKind[];
}

export interface RevokeContext {
  fetch: FetchFn;
  token: string;
  client: { clientId: string; clientSecret: string };
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
  /** Separator of the token response's `scope` field (a space by default). */
  scopeSeparator?: string;
  /** Map a granted scope onto the spelling that was requested. */
  normalizeScope?: (scope: string) => string;
  /** The mailbox address or workspace name the token belongs to. */
  identify: (ctx: { fetch: FetchFn; accessToken: string; tokenResponse: Record<string, unknown> }) => Promise<string>;
  /** Provider-specific revocation; the default posts RFC 7009 to `revokeUrl`. */
  revoke?: (ctx: RevokeContext) => Promise<boolean>;
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

  register(provider: ConnectorProvider): void {
    assertConnectorName(provider.id, "provider");
    if (this.providers.has(provider.id)) throw new Error(`provider ${provider.id} is already registered`);
    assertHttps(provider.authorizeUrl, "authorizeUrl", provider.id);
    assertHttps(provider.tokenUrl, "tokenUrl", provider.id);
    if (provider.revokeUrl !== undefined) assertHttps(provider.revokeUrl, "revokeUrl", provider.id);
    const services = Object.keys(provider.services);
    if (services.length === 0) throw new Error(`provider ${provider.id} declares no services`);
    for (const s of services) assertConnectorName(s, "service");
    this.providers.set(provider.id, provider);
  }

  get(id: string): ConnectorProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): ConnectorProvider[] {
    return [...this.providers.values()];
  }
}

/** Providers that ship with Memrain. Each arrives with its connector. */
export function builtinProviders(): ProviderRegistry {
  return new ProviderRegistry();
}
