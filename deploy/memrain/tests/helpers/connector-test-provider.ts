/**
 * A connector provider that exists only in tests, plus a recorded-response
 * fetch that plays its token, identity and revoke endpoints. No request ever
 * leaves the process.
 */
import type { FetchFn } from "../../src/core/connectors/client.ts";
import type { ConnectorProvider } from "../../src/core/connectors/providers.ts";

export const TEST_ACCESS_TOKEN = "test-live-access-token-0123456789";
export const TEST_REFRESH_TOKEN = "test-live-refresh-token-9876543210";

export function testProvider(id = "test"): ConnectorProvider {
  return {
    id,
    authorizeUrl: "https://auth.provider.test/authorize",
    tokenUrl: "https://auth.provider.test/token",
    revokeUrl: "https://auth.provider.test/revoke",
    baseScopes: ["openid"],
    services: {
      mail: { scopes: ["mail.read"], sourceKinds: ["mailbox"] },
      calendar: { scopes: ["calendar.read"], sourceKinds: ["calendar"] },
    },
    authorizeParams: { access_type: "offline" },
    async identify({ fetch, accessToken }) {
      const res = await fetch("https://api.provider.test/me", { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`identity ${res.status}`);
      const body = (await res.json()) as { email?: unknown };
      if (typeof body.email !== "string") throw new Error("identity has no email");
      return body.email;
    },
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: URLSearchParams | null;
  headers: Record<string, string>;
}

export interface FakeProviderOptions {
  /** The `scope` field of the token response; null leaves it out. */
  grantedScope?: string | null;
  tokenStatus?: number;
  identity?: string;
  refreshToken?: string | null;
}

export function fakeProvider(opts: FakeProviderOptions = {}): { fetch: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body, headers });
    if (url === "https://auth.provider.test/token") {
      if ((opts.tokenStatus ?? 200) !== 200) {
        return Response.json({ error: "invalid_grant", error_description: `echo ${body?.get("code")}` }, { status: opts.tokenStatus });
      }
      return Response.json({
        access_token: TEST_ACCESS_TOKEN,
        ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? TEST_REFRESH_TOKEN }),
        token_type: "Bearer",
        expires_in: 3600,
        ...(opts.grantedScope === null ? {} : { scope: opts.grantedScope ?? "openid mail.read" }),
      });
    }
    if (url === "https://api.provider.test/me") {
      if (headers.authorization !== `Bearer ${TEST_ACCESS_TOKEN}`) return new Response("no", { status: 401 });
      return Response.json({ email: opts.identity ?? "owner@example.test" });
    }
    if (url === "https://auth.provider.test/revoke") return new Response(null, { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}
