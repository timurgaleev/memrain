/**
 * The notification webhook: refused unless https to a public host with a
 * strong secret, signed with HMAC-SHA256 over the timestamp and raw body,
 * pointer-only payload, retried with backoff, never following a redirect.
 * Every request goes to a recorded FetchFn; nothing reaches the network.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageEngines } from "./helpers/storage-engines.ts";
import { registerSource } from "../src/core/sources.ts";
import { openNotice, resolveNotice } from "../src/core/connectors/sync-store.ts";
import { listNotifications, syncNotifications } from "../src/core/notifications/store.ts";
import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  deliverPendingWebhooks,
  loadWebhookConfig,
  signWebhookBody,
  type WebhookConfig,
} from "../src/core/notifications/webhook.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import type { Engine } from "../src/core/engine/interface.ts";

setDefaultTimeout(60000);

const SECRET = "s".repeat(24) + "0123456789abcdef";
const URL_OK = "https://hooks.example.test/memrain";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ALLOWED_KEYS = ["created_at", "id", "kind", "link", "version"];

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "memrain-notify-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadWebhookConfig", () => {
  it("is off and unconfigured when nothing is set", () => {
    expect(loadWebhookConfig({})).toEqual({ config: null, configured: false });
  });

  it("accepts an https URL to a public host with a long secret", () => {
    const r = loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK, MEMRAIN_NOTIFY_WEBHOOK_SECRET: SECRET });
    expect(r.configured).toBe(true);
    expect(r.config?.url.toString()).toBe(URL_OK);
  });

  const refused: Array<[string, Record<string, string>, string]> = [
    ["plain http", { MEMRAIN_NOTIFY_WEBHOOK_URL: "http://hooks.example.test/x" }, "https"],
    ["credentials in the URL", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://u:p@hooks.example.test/x" }, "credentials"],
    ["loopback", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://127.0.0.1/x" }, "private"],
    ["localhost", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://localhost/x" }, "private"],
    ["cloud metadata", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://169.254.169.254/latest" }, "private"],
    ["RFC 1918", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://10.1.2.3/x" }, "private"],
    ["IPv6 loopback", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://[::1]/x" }, "private"],
    ["IPv6 unique local", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://[fd00::1]/x" }, "private"],
    ["IPv4-mapped IPv6", { MEMRAIN_NOTIFY_WEBHOOK_URL: "https://[::ffff:10.0.0.1]/x" }, "private"],
    ["not a URL", { MEMRAIN_NOTIFY_WEBHOOK_URL: "hooks" }, "URL"],
  ];
  for (const [what, env, reason] of refused) {
    it(`refuses ${what}`, () => {
      const r = loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_SECRET: SECRET, ...env });
      expect(r.config).toBeNull();
      expect(r.configured).toBe(true);
      expect(r.reason).toContain(reason);
    });
  }

  it("refuses a missing, short or doubly set secret, and a secret without a URL", () => {
    expect(loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK }).reason).toContain("secret");
    expect(loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK, MEMRAIN_NOTIFY_WEBHOOK_SECRET: "short" }).reason).toContain("32");
    const file = join(dir, "both");
    writeFileSync(file, SECRET, { mode: 0o600 });
    expect(loadWebhookConfig({
      MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK, MEMRAIN_NOTIFY_WEBHOOK_SECRET: SECRET, MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE: file,
    }).reason).toContain("not both");
    const lone = loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_SECRET: SECRET });
    expect(lone).toMatchObject({ config: null, configured: true });
    expect(lone.reason).toContain("MEMRAIN_NOTIFY_WEBHOOK_URL");
  });

  it("reads the secret from an owner-only file and refuses one others can read", () => {
    const file = join(dir, "secret");
    writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
    const ok = loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK, MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE: file });
    expect(ok.config?.secret).toBe(SECRET);
    chmodSync(file, 0o644);
    const wide = loadWebhookConfig({ MEMRAIN_NOTIFY_WEBHOOK_URL: URL_OK, MEMRAIN_NOTIFY_WEBHOOK_SECRET_FILE: file });
    expect(wide.config).toBeNull();
    expect(wide.reason).toContain("chmod");
    // The reason never echoes the secret.
    expect(JSON.stringify(wide)).not.toContain(SECRET);
  });
});

interface Sent { url: string; init: RequestInit; body: string; headers: Headers }

function recorder(answers: Array<number | "throw" | "hang">): { fetch: FetchFn; sent: Sent[] } {
  const sent: Sent[] = [];
  let i = 0;
  const fetch: FetchFn = async (url, init) => {
    const body = String(init.body);
    sent.push({ url, init, body, headers: new Headers(init.headers) });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a === "throw") throw new TypeError("connection refused");
    if (a === "hang") {
      return await new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    }
    return new Response("upstream says: secret internal detail", { status: a, headers: a >= 300 && a < 400 ? { location: "http://169.254.169.254/" } : {} });
  };
  return { fetch, sent };
}

const config: WebhookConfig = { url: new URL(URL_OK), secret: SECRET };

async function seedPending(e: Engine, now: Date): Promise<number> {
  await registerSource(e, { id: "acme", kind: "other", pathPrefix: "acme/" });
  await e.query(
    `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', 'owner@example.test')`,
    [ACCOUNT],
  );
  await openNotice(e, ACCOUNT, "needs_reconnect", "invalid_grant from owner@example.test");
  await syncNotifications(e, { webhook: true, now });
  return (await listNotifications(e))[0]!.id;
}

const row = async (e: Engine, id: number) => (await e.query<{
  webhook_state: string; webhook_attempts: number; webhook_next_at: string | null; webhook_error: string | null;
}>(`SELECT webhook_state, webhook_attempts, webhook_next_at::text AS webhook_next_at, webhook_error FROM notifications WHERE id = $1`, [id])).rows[0]!;

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`webhook delivery (${name})`, () => {
  it("posts a signed, pointer-only payload once", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const now = new Date("2026-11-14T10:00:00Z");
      const id = await seedPending(e, now);
      const rec = recorder([204]);
      const r = await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now, clock: () => now, publicUrl: "https://brain.example.test" });
      expect(r).toEqual({ delivered: 1, retried: 0, failed: 0 });
      expect(rec.sent.length).toBe(1);
      const s = rec.sent[0]!;
      expect(s.url).toBe(URL_OK);
      expect(s.init.method).toBe("POST");
      expect(s.init.redirect).toBe("manual");
      const payload = JSON.parse(s.body) as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(ALLOWED_KEYS);
      expect(payload).toMatchObject({ version: 1, id: String(id), kind: "needs_reconnect", link: `https://brain.example.test/admin#notifications/${id}` });
      expect(s.body).not.toContain("example.test/memrain");
      expect(s.body).not.toContain("owner@");
      expect(s.body).not.toContain("invalid_grant");
      // The receiver recomputes the HMAC over "<timestamp>.<raw body>".
      const ts = s.headers.get("x-memrain-timestamp")!;
      expect(ts).toBe(String(Math.floor(now.getTime() / 1000)));
      const expected = createHmac("sha256", SECRET).update(`${ts}.${s.body}`).digest("hex");
      expect(s.headers.get("x-memrain-signature")).toBe(`sha256=${expected}`);
      expect(signWebhookBody(SECRET, ts, s.body)).toBe(`sha256=${expected}`);
      expect(s.headers.get("x-memrain-notification-id")).toBe(String(id));
      expect(await row(e, id)).toMatchObject({ webhook_state: "delivered", webhook_attempts: 1, webhook_error: null });
      // Delivered rows are never sent again.
      await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now: new Date("2026-11-14T11:00:00Z") });
      expect(rec.sent.length).toBe(1);
    } finally { await db.close(); }
  });

  it("retries a failed delivery with backoff and gives up after the last attempt", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      let now = new Date("2026-11-14T10:00:00Z");
      const id = await seedPending(e, now);
      const rec = recorder([500, "throw", 302, "hang", 503]);
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
        // Not due yet: nothing is sent before the backoff ends.
        if (attempt > 1) {
          const early = await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now: new Date(now.getTime() - 1000), timeoutMs: 50 });
          expect(early).toEqual({ delivered: 0, retried: 0, failed: 0 });
        }
        const r = await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now, timeoutMs: 50 });
        expect(rec.sent.length).toBe(attempt);
        const state = await row(e, id);
        expect(state.webhook_attempts).toBe(attempt);
        if (attempt < WEBHOOK_MAX_ATTEMPTS) {
          expect(r.retried).toBe(1);
          expect(state.webhook_state).toBe("pending");
          const next = new Date(now.getTime() + WEBHOOK_BACKOFF_MS[attempt - 1]!);
          expect(Date.parse(state.webhook_next_at!)).toBe(next.getTime());
          now = next;
        } else {
          expect(r.failed).toBe(1);
          expect(state.webhook_state).toBe("failed");
          expect(state.webhook_next_at).toBeNull();
        }
      }
      // Error codes only: never the receiver's response text.
      const codes = rec.sent.length;
      expect(codes).toBe(WEBHOOK_MAX_ATTEMPTS);
      const final = await row(e, id);
      expect(final.webhook_error).toBe("http_503");
      const all = JSON.stringify(await listNotifications(e, { includeResolved: true }));
      expect(all).not.toContain("secret internal detail");
    } finally { await db.close(); }
  });

  it("records a redirect, a refused connection and a timeout as short codes", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      let now = new Date("2026-11-14T10:00:00Z");
      const id = await seedPending(e, now);
      for (const [answer, code] of [[301, "http_301"], ["throw", "network"], ["hang", "timeout"]] as const) {
        const rec = recorder([answer]);
        await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now, timeoutMs: 50 });
        expect(rec.sent.length).toBe(1);
        const state = await row(e, id);
        expect(state.webhook_error).toBe(code);
        now = new Date(Date.parse(state.webhook_next_at!));
      }
    } finally { await db.close(); }
  });

  it("does not send a notification whose problem was resolved first", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const now = new Date("2026-11-14T10:00:00Z");
      const id = await seedPending(e, now);
      await resolveNotice(e, ACCOUNT, "needs_reconnect");
      await syncNotifications(e, { webhook: true, now });
      const rec = recorder([204]);
      await deliverPendingWebhooks(e, config, { fetch: rec.fetch, now });
      expect(rec.sent.length).toBe(0);
      expect((await row(e, id)).webhook_state).toBe("cancelled");
    } finally { await db.close(); }
  });

  it("stamps each POST with the time it is sent, not when the drain began", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const now = new Date("2026-11-14T10:00:00Z");
      await seedPending(e, now);
      const second = "66666666-6666-4666-8666-666666666666";
      await e.query(
        `INSERT INTO connector_accounts (id, source_id, provider, principal_ref, account_label) VALUES ($1, 'acme', 'test', 'admin:operator', 'second@example.test')`,
        [second],
      );
      await openNotice(e, second, "needs_reconnect", "invalid_grant");
      await syncNotifications(e, { webhook: true, now });
      // A slow receiver: each POST takes three minutes of wall clock.
      let wall = now.getTime();
      const rec = recorder([204]);
      const slow: FetchFn = async (url, init) => {
        const res = await rec.fetch(url, init);
        wall += 180_000;
        return res;
      };
      const r = await deliverPendingWebhooks(e, config, { fetch: slow, now, clock: () => new Date(wall) });
      expect(r.delivered).toBe(2);
      const stamps = rec.sent.map(s => Number(s.headers.get("x-memrain-timestamp")));
      expect(stamps).toEqual([now.getTime() / 1000, now.getTime() / 1000 + 180]);
      for (const s of rec.sent) {
        const ts = s.headers.get("x-memrain-timestamp")!;
        expect(s.headers.get("x-memrain-signature")).toBe(signWebhookBody(SECRET, ts, s.body));
      }
    } finally { await db.close(); }
  });

  it("two drains at once send each notification once", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      const now = new Date("2026-11-14T10:00:00Z");
      await seedPending(e, now);
      const rec = recorder([204]);
      await Promise.all([
        deliverPendingWebhooks(e, config, { fetch: rec.fetch, now }),
        deliverPendingWebhooks(e, config, { fetch: rec.fetch, now }),
      ]);
      expect(rec.sent.length).toBe(1);
    } finally { await db.close(); }
  });
});
