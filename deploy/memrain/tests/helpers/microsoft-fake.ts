/**
 * A recorded Microsoft account for connector tests: the identity platform's
 * v2.0 token endpoint (any tenant segment) and Microsoft Graph `/me`, each
 * answering from tests/fixtures/connectors/microsoft-identity.json (shaped
 * after the documented responses). Nothing leaves the process; every request
 * is recorded so a test can assert what was asked, and where.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";

type Json = Record<string, unknown>;

export const MS_FIXTURES = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "connectors", "microsoft-identity.json"), "utf8"),
) as Record<string, Json>;

export const MS_ACCESS_TOKEN = String(MS_FIXTURES.token!.access_token);
export const MS_REFRESH_TOKEN = String(MS_FIXTURES.token!.refresh_token);
export const MS_ROTATED_ACCESS_TOKEN = String(MS_FIXTURES.tokenRefresh!.access_token);
export const MS_ROTATED_REFRESH_TOKEN = String(MS_FIXTURES.tokenRefresh!.refresh_token);

const TOKEN_RE = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/oauth2\/v2\.0\/token$/;

export interface MicrosoftCall {
  url: URL;
  method: string;
  body: URLSearchParams | null;
  authorization: string | null;
}

export interface MicrosoftWorld {
  /** The token response's `scope` on a code exchange; null leaves it out. */
  grantedScope?: string | null;
  /** A fixture name the code exchange answers with HTTP 400 instead of tokens. */
  codeError?: string;
  /** A fixture name the refresh grant answers with HTTP 400 instead of tokens. */
  refreshError?: string;
  /** Which `/me` fixture answers. */
  me?: string;
  /** The code exchange answers without a refresh token. */
  omitRefreshToken?: boolean;
  calls: MicrosoftCall[];
}

export function microsoftFetch(world: MicrosoftWorld): FetchFn {
  return async (raw, init) => {
    const url = new URL(raw);
    const authorization = new Headers(init.headers).get("authorization");
    const body = typeof init.body === "string" ? new URLSearchParams(init.body) : null;
    world.calls.push({ url, method: init.method ?? "GET", body, authorization });

    if (TOKEN_RE.test(raw) && init.method === "POST") {
      if (body?.get("grant_type") === "refresh_token") {
        if (world.refreshError) return Response.json(MS_FIXTURES[world.refreshError], { status: 400 });
        return Response.json(MS_FIXTURES.tokenRefresh);
      }
      if (world.codeError) return Response.json(MS_FIXTURES[world.codeError], { status: 400 });
      const { scope, refresh_token: refreshToken, ...others } = MS_FIXTURES.token!;
      const rest = world.omitRefreshToken ? others : { ...others, refresh_token: refreshToken };
      const granted = world.grantedScope === undefined ? scope : world.grantedScope;
      return Response.json(granted === null ? rest : { ...rest, scope: granted });
    }
    if (url.origin === "https://graph.microsoft.com" && url.pathname === "/v1.0/me") {
      if (authorization !== `Bearer ${MS_ACCESS_TOKEN}`) {
        return Response.json({ error: { code: "InvalidAuthenticationToken", message: "Access token is empty." } }, { status: 401 });
      }
      return Response.json(MS_FIXTURES[world.me ?? "me"]);
    }
    return Response.json({ error: { code: "NotFound", message: "not recorded" } }, { status: 404 });
  };
}

/** The tenant segment of a recorded token-endpoint call. */
export function tokenTenant(call: MicrosoftCall): string | null {
  return TOKEN_RE.exec(call.url.toString())?.[1] ?? null;
}
