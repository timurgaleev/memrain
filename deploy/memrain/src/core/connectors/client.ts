/**
 * A fixed-origin HTTP client for a connector provider.
 *
 * It only ever talks to one origin: callers pass paths, never URLs, and a
 * pagination link is followed only when it points back at the same origin. A
 * redirect is never followed. So a crafted `Link` header or a redirect cannot
 * walk the credential to another host.
 *
 * Requests are spaced by a minimum interval. A rate limit is waited out when
 * the provider says how long (`Retry-After`, or `X-RateLimit-Reset`) and the
 * wait fits under a cap; past the cap the client gives up with `rate_limited`
 * instead of parking the run for an hour. Server errors and network failures
 * are retried a bounded number of times with a growing back-off.
 *
 * The credential is a static token (GitHub) or a token source that can renew
 * it. With a source, a 401 earns exactly one forced refresh and one retry; a
 * second 401, or a refresh the provider refuses, ends the request
 * `auth_required` with `reauth` set, which the sync engine turns into a paused
 * account waiting for its owner to reconnect.
 *
 * A token lives in the Authorization header only. Error text is built from
 * status codes and classes, and anything that does quote a thrown message has
 * every token this client sent scrubbed from it first.
 */
import { classifyResponse, CLASSIFY_BODY_PREFIX } from "./classify.ts";
import type { ProviderLimiter } from "./limiter.ts";
import { ReauthRequiredError, type ResponseClass } from "./types.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A credential that can be renewed. `token` returns the access token to send;
 * `refresh` is called with the token the provider just refused and returns a
 * fresh one. Either throws ReauthRequiredError when only a reconnect helps.
 */
export interface TokenSource {
  token(): Promise<string>;
  refresh(stale: string): Promise<string>;
}

export interface ConnectorClientOptions {
  origin: string;
  /** A static token. Exactly one of `token` and `tokenSource`. */
  token?: string;
  tokenSource?: TokenSource;
  /** Shared pacing for every client of one account; replaces `minSpacingMs`. */
  limiter?: ProviderLimiter;
  /** Extra request headers (Accept, API version, User-Agent). */
  headers?: Record<string, string>;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between two requests, in ms. */
  minSpacingMs?: number;
  /** Longest single wait for a rate limit or back-off, in ms. */
  maxWaitMs?: number;
  /** Retries after the first attempt, for server errors and rate limits. */
  maxRetries?: number;
}

export interface ConnectorResponse {
  class: ResponseClass;
  /** HTTP status, or 0 when no response arrived (network failure). */
  status: number;
  /** Parsed JSON body; set only when `class` is `ok`. */
  body: unknown;
  /** Path of the next page on the same origin, when the response names one. */
  next: string | null;
  /** Why the request did not end `ok`, safe to print. */
  error: string | null;
  /** Set on `auth_required` when the credential cannot be renewed: the owner has to reconnect. */
  reauth?: boolean;
}

/** A path or pagination link the client refuses to request. */
export class ConnectorRequestError extends Error {}

const DEFAULT_SPACING_MS = 250;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/** GitHub's advice for a secondary limit that names no wait. */
const UNSPECIFIED_RATE_LIMIT_WAIT_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The `rel="next"` target of a `Link` header, or null. Split on commas and
 * angle brackets with indexOf, so a hostile header costs one pass.
 */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!part.includes('rel="next"')) continue;
    const open = part.indexOf("<");
    const close = part.indexOf(">", open + 1);
    if (open === -1 || close === -1) return null;
    return part.slice(open + 1, close).trim();
  }
  return null;
}

export class ConnectorClient {
  private readonly origin: string;
  private readonly tokenSource: TokenSource;
  /** False for a static token: a 401 cannot be fixed by asking again. */
  private readonly renewable: boolean;
  private readonly limiter: ProviderLimiter | null;
  /** Every token this client has put on the wire, for scrubbing error text. */
  private readonly sent = new Set<string>();
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minSpacingMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRetries: number;
  private lastRequestAt: number | null = null;

  constructor(opts: ConnectorClientOptions) {
    const origin = new URL(opts.origin).origin;
    if (!origin.startsWith("https://")) throw new ConnectorRequestError(`connector origin must be https (got ${origin})`);
    if ((opts.token === undefined) === (opts.tokenSource === undefined)) {
      throw new ConnectorRequestError("connector client takes exactly one of a token and a token source");
    }
    if (opts.token !== undefined && opts.token.length === 0) throw new ConnectorRequestError("connector token is empty");
    this.origin = origin;
    const fixed = opts.token;
    this.renewable = fixed === undefined;
    this.tokenSource = opts.tokenSource ?? { token: async () => fixed!, refresh: async () => fixed! };
    this.limiter = opts.limiter ?? null;
    this.headers = opts.headers ?? {};
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.minSpacingMs = opts.minSpacingMs ?? DEFAULT_SPACING_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Resolve a relative path against the fixed origin; anything else is refused. */
  private urlFor(path: string): string {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
      throw new ConnectorRequestError(`connector requests take a path on ${this.origin}, not ${JSON.stringify(path.slice(0, 80))}`);
    }
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new ConnectorRequestError(`connector path left ${this.origin}`);
    return url.toString();
  }

  /** A pagination link as a path on the fixed origin, or a refusal. */
  private nextPath(link: string | null): string | null {
    if (link === null) return null;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      throw new ConnectorRequestError("pagination link is not a URL");
    }
    if (url.origin !== this.origin) {
      throw new ConnectorRequestError(`pagination link points off ${this.origin}; not followed`);
    }
    return `${url.pathname}${url.search}`;
  }

  private scrub(text: string): string {
    let out = text;
    for (const token of this.sent) out = out.split(token).join("[token]");
    return out;
  }

  /** Wait for this request's slot; a reason string when it may not go at all. */
  private async space(): Promise<string | null> {
    if (this.limiter !== null) return this.limiter.acquire();
    if (this.lastRequestAt === null) return null;
    const wait = this.lastRequestAt + this.minSpacingMs - this.now();
    if (wait > 0) await this.sleep(wait);
    return null;
  }

  /** The token to send, or the response that ends the request when there is none. */
  private async currentToken(): Promise<string | ConnectorResponse> {
    try {
      const token = await this.tokenSource.token();
      if (token.length === 0) throw new ReauthRequiredError("the credential holds no access token");
      return token;
    } catch (e) {
      return this.tokenFailure(e, "token unavailable");
    }
  }

  private tokenFailure(e: unknown, what: string): ConnectorResponse {
    if (e instanceof ReauthRequiredError) {
      return {
        class: "auth_required",
        status: 0,
        body: null,
        next: null,
        error: `${what}: the provider will not renew the credential; reconnect the account`,
        reauth: true,
      };
    }
    // A token endpoint that is down or slow is not the owner's problem: the
    // next run tries again.
    const reason = this.scrub(e instanceof Error ? e.message : String(e));
    return { class: "server_error", status: 0, body: null, next: null, error: `${what}: ${reason}` };
  }

  /** How long the provider asked us to wait, in ms, or the default. */
  private rateLimitWait(res: Response): number {
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter !== null) {
      const secs = Number(retryAfter.trim());
      if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    }
    if (res.headers.get("x-ratelimit-remaining")?.trim() === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")?.trim());
      if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - this.now());
    }
    return UNSPECIFIED_RATE_LIMIT_WAIT_MS;
  }

  async get(path: string): Promise<ConnectorResponse> {
    const url = this.urlFor(path);
    let refreshed = false;
    let pending = await this.currentToken();
    for (let attempt = 0; ; attempt++) {
      if (typeof pending !== "string") return pending;
      const token = pending;
      const refusal = await this.space();
      if (refusal !== null) return { class: "rate_limited", status: 0, body: null, next: null, error: refusal };
      this.lastRequestAt = this.now();
      this.sent.add(token);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(url, {
          method: "GET",
          redirect: "manual",
          headers: { ...this.headers, Authorization: `Bearer ${token}` },
        });
        text = await res.text();
      } catch (e) {
        const reason = this.scrub(e instanceof Error ? e.message : String(e));
        if (attempt >= this.maxRetries) {
          return { class: "server_error", status: 0, body: null, next: null, error: `network error: ${reason}` };
        }
        await this.sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, this.maxWaitMs));
        continue;
      }

      const cls = classifyResponse(res.status, res.headers, text.slice(0, CLASSIFY_BODY_PREFIX));
      if (cls === "auth_required" && this.renewable) {
        if (refreshed) {
          return {
            class: "auth_required",
            status: res.status,
            body: null,
            next: null,
            error: `HTTP ${res.status} after a token refresh; reconnect the account`,
            reauth: true,
          };
        }
        refreshed = true;
        try {
          pending = await this.tokenSource.refresh(token);
        } catch (e) {
          return this.tokenFailure(e, "token refresh failed");
        }
        // Asking with a renewed credential is not a retry of a flaky request.
        attempt--;
        continue;
      }
      if (cls === "ok") {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return { class: "challenge", status: res.status, body: null, next: null, error: `HTTP ${res.status} body is not JSON` };
        }
        return { class: "ok", status: res.status, body, next: this.nextPath(parseNextLink(res.headers.get("link"))), error: null };
      }
      if (cls === "rate_limited") {
        const wait = this.rateLimitWait(res);
        if (wait > this.maxWaitMs || attempt >= this.maxRetries) {
          return {
            class: "rate_limited",
            status: res.status,
            body: null,
            next: null,
            error: `HTTP ${res.status} rate limited; the provider asked for ${Math.ceil(wait / 1000)}s`,
          };
        }
        await this.sleep(wait);
        continue;
      }
      if (cls === "server_error" && attempt < this.maxRetries) {
        await this.sleep(Math.min(BASE_BACKOFF_MS * 2 ** attempt, this.maxWaitMs));
        continue;
      }
      return { class: cls, status: res.status, body: null, next: null, error: `HTTP ${res.status} (${cls})` };
    }
  }
}
