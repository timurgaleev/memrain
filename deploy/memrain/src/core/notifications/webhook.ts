/**
 * The owner's notification webhook: one signed POST per notification, with
 * retries, off unless configured.
 *
 *   MEMRAIN_NOTIFY_WEBHOOK_URL          https URL of the receiver
 *   MEMRAIN_NOTIFY_WEBHOOK_SECRET       shared HMAC secret, at least 32 characters
 *   MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE  or a file holding it, readable by its owner only
 *
 * The body is a pointer, never content: `{version, id, kind, link, created_at}`.
 * The receiver follows the link into the admin, behind its session.
 *
 * Signature: `x-memrain-signature: sha256=<hex>` is HMAC-SHA256 with the
 * secret over `<x-memrain-timestamp>.<raw body>`, so a receiver can refuse a
 * stale timestamp (a replay) and dedupe on `x-memrain-notification-id`.
 * Delivery is at least once: a crash between the POST and the bookkeeping
 * sends the same id again.
 *
 * The URL is refused unless it is https to a host that is not a loopback,
 * private, link-local or metadata address literal (or `localhost`), carries no
 * credentials, and a redirect is never followed: a 3xx is a failed attempt.
 * A hostname is not resolved here; the operator who sets the URL is trusted
 * with where it points.
 */
import { createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { Engine } from "../engine/interface.ts";
import type { FetchFn } from "../connectors/client.ts";
import { notificationLink, type NotificationKind } from "./store.ts";

export interface WebhookConfig {
  url: URL;
  secret: string;
}

export interface WebhookConfigLoad {
  config: WebhookConfig | null;
  /** True when any webhook variable is set, so a refusal is worth reporting. */
  configured: boolean;
  reason?: string;
}

const MIN_SECRET_CHARS = 32;
const MAX_SECRET_FILE_BYTES = 4096;
/** Wait after attempt n (1-based) before attempt n + 1. */
export const WEBHOOK_BACKOFF_MS: readonly number[] = [5, 15, 60, 240].map(m => m * 60_000);
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_MS.length + 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH = 20;

const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** The IPv4 address an IPv4-mapped IPv6 literal (`::ffff:…`) carries, or null. */
function mappedIpv4(ip: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1]!;
  if (isIPv4(tail)) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || !groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const n = (Number.parseInt(groups[0]!, 16) << 16 | Number.parseInt(groups[1]!, 16)) >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function ipv6Private(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  const mapped = mappedIpv4(lower);
  if (mapped !== null) return ipv4Private(mapped);
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
    || (first & 0xff00) === 0xff00; // multicast
}

/** True for a host the webhook must never be pointed at. */
export function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIPv4(host)) return ipv4Private(host);
  if (isIPv6(host)) return ipv6Private(host);
  return false;
}

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: AddressLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * `inner`, refusing a URL whose host name resolves to any address the webhook
 * must never reach. The configured URL is checked as written at load time; a
 * name can still resolve somewhere private, so it is resolved again before
 * each POST. A name that changes its answer between this lookup and the
 * connection is not caught; the POST carries only a signed pointer and its
 * answer is discarded.
 */
export function publicWebhookFetch(inner: FetchFn, lookup: AddressLookup = systemLookup): FetchFn {
  return async (url, init) => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!isIPv4(host) && !isIPv6(host)) {
      const addresses = await lookup(host);
      if (addresses.length === 0 || addresses.some(a => privateHost(a.address))) {
        const err = new Error("the webhook host resolves to a loopback, private or link-local address");
        err.name = "PrivateAddressError";
        throw err;
      }
    }
    return inner(url, init);
  };
}

function readSecretFile(file: string): { secret: string } | { reason: string } {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { reason: "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE cannot be read" };
  }
  if (!st.isFile()) return { reason: "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE is not a regular file" };
  if ((st.mode & 0o077) !== 0) return { reason: "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE is readable by group or other; chmod 0400 it" };
  if (st.size > MAX_SECRET_FILE_BYTES) return { reason: "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE is too large to be a secret" };
  try {
    return { secret: readFileSync(file, "utf8").trim() };
  } catch {
    return { reason: "MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE cannot be read" };
  }
}

/** Read and check the webhook settings. Returns a reason instead of throwing. */
export function loadWebhookConfig(env: NodeJS.ProcessEnv = process.env): WebhookConfigLoad {
  const rawUrl = env.MEMRAIN_NOTIFY_WEBHOOK_URL;
  const inline = env.MEMRAIN_NOTIFY_WEBHOOK_SECRET;
  const file = env.MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE;
  if (!set(rawUrl) && !set(inline) && !set(file)) return { config: null, configured: false };
  const refuse = (reason: string): WebhookConfigLoad => ({ config: null, configured: true, reason });
  if (!set(rawUrl)) return refuse("a webhook secret is set but MEMRAIN_NOTIFY_WEBHOOK_URL is not");
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return refuse("MEMRAIN_NOTIFY_WEBHOOK_URL is not a URL");
  }
  if (url.protocol !== "https:") return refuse("MEMRAIN_NOTIFY_WEBHOOK_URL must use https");
  if (url.username !== "" || url.password !== "") return refuse("MEMRAIN_NOTIFY_WEBHOOK_URL must not carry credentials; use the secret");
  if (privateHost(url.hostname)) return refuse("MEMRAIN_NOTIFY_WEBHOOK_URL points at a loopback, private or link-local address");
  if (set(inline) && set(file)) return refuse("set MEMRAIN_NOTIFY_WEBHOOK_SECRET or MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE, not both");
  let secret: string;
  if (set(inline)) {
    secret = inline.trim();
  } else if (set(file)) {
    const read = readSecretFile(file);
    if ("reason" in read) return refuse(read.reason);
    secret = read.secret;
  } else {
    return refuse("no webhook secret: set MEMRAIN_NOTIFY_WEBHOOK_SECRET or MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE");
  }
  if (secret.length < MIN_SECRET_CHARS) return refuse(`the webhook secret must be at least ${MIN_SECRET_CHARS} characters`);
  return { config: { url, secret }, configured: true };
}

/** `sha256=<hex>` over `<timestamp>.<body>`. */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function absoluteLink(id: number, publicUrl: string | undefined): string {
  const path = notificationLink(id);
  let base = (publicUrl ?? "").trim();
  while (base.endsWith("/")) base = base.slice(0, -1);
  return /^https?:\/\/[^/\s]+/i.test(base) ? `${base}${path}` : path;
}

export interface DeliveryResult {
  delivered: number;
  retried: number;
  failed: number;
}

export interface DeliverOptions {
  fetch?: FetchFn;
  /** Decides what is due and the backoff; defaults to the current time. */
  now?: Date;
  /** The time each POST is signed with, read as it is sent (default: the wall clock). */
  clock?: () => Date;
  timeoutMs?: number;
  batch?: number;
  /** Base for an absolute link; defaults to MEMRAIN_PUBLIC_URL. */
  publicUrl?: string;
}

interface Claimed {
  id: number | string;
  kind: NotificationKind;
  created_at: string;
  webhook_attempts: number | string;
}

async function post(fetchFn: FetchFn, config: WebhookConfig, body: string, id: number, sentAt: Date, timeoutMs: number): Promise<string | null> {
  // A drain sends up to a batch in a row, each up to its timeout; signing with
  // the drain's start time would hand a late receiver a stale timestamp.
  const timestamp = String(Math.floor(sentAt.getTime() / 1000));
  try {
    const res = await fetchFn(config.url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "memrain-notify/1",
        "x-memrain-timestamp": timestamp,
        "x-memrain-signature": signWebhookBody(config.secret, timestamp, body),
        "x-memrain-notification-id": String(id),
      },
      body,
    });
    await res.body?.cancel().catch(() => {});
    return res.status >= 200 && res.status < 300 ? null : `http_${res.status}`;
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "PrivateAddressError") return "private_address";
    return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  }
}

/**
 * Send the webhook for every pending notification that is due, one at a time.
 * A row is leased before it is sent, so two drains never send it twice; a
 * failure is retried after WEBHOOK_BACKOFF_MS and marked `failed` after
 * WEBHOOK_MAX_ATTEMPTS attempts.
 */
export async function deliverPendingWebhooks(engine: Engine, config: WebhookConfig, opts: DeliverOptions = {}): Promise<DeliveryResult> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const batch = opts.batch ?? DEFAULT_BATCH;
  const fetchFn = opts.fetch ?? publicWebhookFetch((url, init) => fetch(url, init));
  const clock = opts.clock ?? (() => new Date());
  const publicUrl = opts.publicUrl ?? process.env.MEMRAIN_PUBLIC_URL;
  const leaseUntil = new Date(now.getTime() + batch * timeoutMs + 60_000).toISOString();
  // scope: operator-only the operator's webhook carries every source's notifications
  const claimed = (await engine.query<Claimed>(
    `UPDATE notifications SET webhook_lease_until = $2
      WHERE id IN (SELECT id FROM notifications
                    WHERE webhook_state = 'pending' AND webhook_next_at <= $1
                      AND (webhook_lease_until IS NULL OR webhook_lease_until < $1)
                    ORDER BY webhook_next_at, id LIMIT $3
                    FOR UPDATE SKIP LOCKED)
      RETURNING id, kind, created_at::text AS created_at, webhook_attempts`,
    [now.toISOString(), leaseUntil, batch],
  )).rows;
  const result: DeliveryResult = { delivered: 0, retried: 0, failed: 0 };
  for (const row of claimed) {
    const id = Number(row.id);
    // An earlier POST in this batch can take seconds; a sync may have resolved
    // this one meanwhile, and a resolved problem is not worth a message.
    // scope: operator-only the operator's webhook outbox covers every source
    const still = await engine.query(`SELECT 1 FROM notifications WHERE id = $1 AND webhook_state = 'pending'`, [id]);
    if (still.rows.length === 0) continue;
    const body = JSON.stringify({
      version: 1,
      id: String(id),
      kind: row.kind,
      link: absoluteLink(id, publicUrl),
      created_at: new Date(row.created_at).toISOString(),
    });
    const error = await post(fetchFn, config, body, id, clock(), timeoutMs);
    const attempts = Number(row.webhook_attempts) + 1;
    if (error === null) {
      await engine.query(
        `UPDATE notifications SET webhook_state = 'delivered', webhook_attempts = $2, webhook_delivered_at = $3,
                webhook_next_at = NULL, webhook_lease_until = NULL, webhook_error = NULL
          WHERE id = $1 AND webhook_state = 'pending'`,
        [id, attempts, now.toISOString()],
      );
      result.delivered++;
      continue;
    }
    const last = attempts >= WEBHOOK_MAX_ATTEMPTS;
    const next = last ? null : new Date(now.getTime() + WEBHOOK_BACKOFF_MS[attempts - 1]!).toISOString();
    await engine.query(
      `UPDATE notifications SET webhook_state = $2, webhook_attempts = $3, webhook_next_at = $4,
              webhook_lease_until = NULL, webhook_error = $5
        WHERE id = $1 AND webhook_state = 'pending'`,
      [id, last ? "failed" : "pending", attempts, next, error],
    );
    if (last) result.failed++;
    else result.retried++;
  }
  return result;
}
