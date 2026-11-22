/**
 * Gmail send-as aliases, on both engines: a run stores the account's aliases
 * (valid addresses only, lowercased) and asks again at most once a day; a
 * refused or failed check keeps the stored list and the run completes; an
 * alias is the account's own address, so enrichment never links it or makes
 * it a wanted person; and aliases arriving later rewrite no stored page.
 */
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { fixtureMessages, GMAIL_FIXTURES, gmailFetch, plainMessage, sendAsCalls, type GmailWorld, type RawMessage } from "./helpers/gmail-fake.ts";
import { GOOGLE_ACCESS_TOKEN } from "./helpers/google-calendar-fake.ts";
import { registerSource } from "../src/core/sources.ts";
import { putPage } from "../src/core/pages.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { createAccount, getAccount, setAccountConfig, setAccountEnabled, storeCredential } from "../src/core/connectors/accounts.ts";
import { ProviderRegistry } from "../src/core/connectors/providers.ts";
import { runConnectorSync } from "../src/core/connectors/sync-engine.ts";
import { connectorRuntime } from "../src/core/connectors/runtime.ts";
import { ownAddresses } from "../src/core/connectors/model.ts";
import { GOOGLE_GMAIL_READONLY, googleProvider } from "../src/core/connectors/google/provider.ts";
import { MAX_SENDAS_ALIASES, parseSendAs } from "../src/core/connectors/google/send-as.ts";
import type { FetchFn } from "../src/core/connectors/client.ts";
import { _resetLimitersForTesting } from "../src/core/connectors/limiter.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import type { Storage } from "../src/core/storage.ts";
import { deterministicEmbed } from "./det-embed.ts";

setDefaultTimeout(60_000);

const kek = kekFromBytes(randomBytes(32));
const SOURCE = "mail";
const OWNER = "owner@example.test";
const ALIAS = "owner.alias@example.org";
const T0 = Date.parse("2026-11-16T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENV: NodeJS.ProcessEnv = {
  MEMRAIN_CONNECTORS_ENABLED: "1",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_ID: "env-client.apps.googleusercontent.com",
  MEMRAIN_GOOGLE_OAUTH_CLIENT_SECRET: "env-client-secret-value",
};
const SENDAS_TWO = { status: 200, body: { sendAs: [{ sendAsEmail: "Owner.Alias@Example.ORG" }, { sendAsEmail: "" }, { sendAsEmail: "Help@Example.NET" }, { sendAsEmail: "not an address" }, { displayName: "no address" }] } };

beforeEach(() => _resetLimitersForTesting());
afterEach(() => _resetLimitersForTesting());

describe("send-as listing", () => {
  // Value: protects=only bare addresses become own addresses; fails_when=an empty, display-name or malformed entry is stored; why_new=no parser existed; seam=pure function.
  it("keeps valid addresses only, lowercased and deduplicated, capped", () => {
    expect(parseSendAs(SENDAS_TWO.body)).toEqual(["owner.alias@example.org", "help@example.net"]);
    expect(parseSendAs({})).toBeNull();
    expect(parseSendAs({ sendAs: [] })).toEqual([]);
    expect(parseSendAs({ sendAs: ["a@@b.org", "a@b@c.org", "Name <x@y.org>", "x@localhost", "ok@b.org"].map(sendAsEmail => ({ sendAsEmail })) })).toEqual(["ok@b.org"]);
    expect(parseSendAs({ sendAs: "x" })).toBeNull();
    expect(parseSendAs(null)).toBeNull();
    const many = { sendAs: Array.from({ length: 80 }, (_, i) => ({ sendAsEmail: `a${i}@example.org` })) };
    expect(parseSendAs(many)).toHaveLength(MAX_SENDAS_ALIASES);
    expect(ownAddresses(OWNER, { sendas_aliases: [ALIAS, 7, "  HELP@example.net "] })).toEqual([OWNER, ALIAS, "help@example.net"]);
  });
});

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail send-as aliases (${name})`, () => {
  function providers(): ProviderRegistry {
    const r = new ProviderRegistry();
    r.register(googleProvider());
    return r;
  }

  async function connected(storage: Storage, config: Record<string, unknown> = {}): Promise<string> {
    const e = storage.engine();
    await registerSource(e, { id: SOURCE, kind: "mailbox", pathPrefix: "mail/" });
    const account = await createAccount(e, { sourceId: SOURCE, provider: "google", services: ["gmail"], principalRef: "admin:operator", accountLabel: OWNER });
    await storeCredential(e, kek, account, { access_token: GOOGLE_ACCESS_TOKEN, refresh_token: "1//test-refresh" }, {
      scopes: ["email", GOOGLE_GMAIL_READONLY, "openid"], expiresAt: new Date(T0 + 3_000_000),
    });
    if (Object.keys(config).length > 0) await setAccountConfig(e, account.id, config);
    await setAccountEnabled(e, account.id, true);
    return account.id;
  }

  async function run(storage: Storage, fetch: FetchFn, accountId: string, at = T0) {
    const rt = connectorRuntime(storage, {
      kek, providers: providers(), fetch, env: ENV, now: () => at, sleep: async () => {},
      embedFn: async (t: string) => deterministicEmbed(t),
    });
    const account = (await rt.loadAccount(accountId))!;
    return runConnectorSync(storage, account, rt.depsFor(account));
  }

  const world = (over: Partial<GmailWorld> = {}): GmailWorld => ({ messages: fixtureMessages(), profile: "profile", history: () => "historyEmpty", calls: [], ...over });
  const config = async (e: Engine, id: string) => (await getAccount(e, id))!.config;

  // Value: protects=aliases are stored at the first run and the daily quota call is not repeated; fails_when=the list is not stored, is stored raw, or is fetched every run; why_new=new behavior; seam=recorded Gmail fake through the real runtime.
  it("stores the aliases on a run and asks again only once a day", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world({ sendAs: SENDAS_TWO });
      expect((await run(db.storage, gmailFetch(w), id)).status).toBe("success");
      expect(sendAsCalls(w)).toBe(1);
      const c = await config(e, id);
      expect(c.sendas_aliases).toEqual(["owner.alias@example.org", "help@example.net"]);
      expect(c.sendas_checked_at).toBe(new Date(T0).toISOString());

      w.calls.length = 0;
      await run(db.storage, gmailFetch(w), id, T0 + 23 * HOUR);
      expect(sendAsCalls(w)).toBe(0);
      w.sendAs = { status: 200, body: { sendAs: [{ sendAsEmail: "help@example.net" }] } };
      await run(db.storage, gmailFetch(w), id, T0 + 25 * HOUR);
      expect(sendAsCalls(w)).toBe(1);
      expect((await config(e, id)).sendas_aliases).toEqual(["help@example.net"]);
    } finally { await db.close(); }
  });

  // Value: protects=a passing refusal or outage never wipes the stored aliases; fails_when=a 403 or network failure stores [] or fails the run; why_new=new behavior (the stored list is kept, unlike a fresh fetch returning []); seam=recorded Gmail fake.
  it("a refused or failed check keeps the stored list and the run completes", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage, { sendas_aliases: [ALIAS], sendas_checked_at: new Date(T0 - 2 * DAY).toISOString() });
      const w = world({ sendAs: { status: 403, body: { error: { code: 403, message: "Insufficient Permission" } } } });
      expect((await run(db.storage, gmailFetch(w), id)).status).toBe("success");
      expect(sendAsCalls(w)).toBe(1);
      expect((await config(e, id)).sendas_aliases).toEqual([ALIAS]);
      expect((await config(e, id)).sendas_checked_at).toBe(new Date(T0).toISOString());

      // A network failure on the call: the run still completes, the list stays.
      const inner = gmailFetch(world());
      const throwing: FetchFn = async (url, init) => {
        if (new URL(url).pathname.endsWith("/settings/sendAs")) throw new TypeError("network down");
        return inner(url, init);
      };
      const result = await run(db.storage, throwing, id, T0 + 2 * DAY);
      expect(result.status === "success" || result.status === "nothing_new").toBe(true);
      expect((await config(e, id)).sendas_aliases).toEqual([ALIAS]);
    } finally { await db.close(); }
  });

  // Value: protects=an alias is never linked to a person page or made a wanted person; fails_when=enrichment uses the run-start account row, which has no aliases yet, or the label alone; why_new=new behavior; seam=real runtime enrichment.
  it("enrichment never links an alias or makes it a wanted person, from the run that first learns it", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      await putPage(db.storage, { slug: "people/owner-alias", markdown_body: "Me.", compiled_truth: { aliases: [ALIAS] } });
      const msg: RawMessage = plainMessage("al1", "tal", T0 - 3 * DAY,
        { "From": "Ben Ortiz <ben@example.com>", "To": `Owner Alias <${ALIAS}>`, "Cc": "Dana Fox <dana@example.com>", "Subject": "Draft", "Message-ID": "<al1@example.com>" },
        "Here is the draft.");
      const w = world({ messages: [msg], sendAs: { status: 200, body: { sendAs: [{ sendAsEmail: ALIAS }] } } });
      expect((await run(db.storage, gmailFetch(w), id)).status).toBe("success");
      const slug = (await e.query<{ page_slug: string }>(`SELECT page_slug FROM connector_items WHERE account_id = $1 AND external_id = 'tal'`, [id])).rows[0]!.page_slug;
      const links = (await e.query<{ target_slug: string }>(`SELECT target_slug FROM links WHERE source_slug = $1`, [slug])).rows.map(r => r.target_slug);
      expect(links).not.toContain("people/owner-alias");
      const wanted = (await e.query<{ target_slug: string }>(`SELECT target_slug FROM wanted_links WHERE from_slug = $1 ORDER BY target_slug`, [slug])).rows.map(r => r.target_slug);
      // Enrichment ran: the other people on the thread are wanted, the alias is not.
      expect(wanted).toEqual(["people/ben-ortiz", "people/dana-fox"]);
    } finally { await db.close(); }
  });

  // Value: protects=aliases arriving after deploy rewrite no stored mail page; fails_when=own addresses reach the page body or the version check; why_new=the live me-mail must not churn; seam=recorded Gmail fake, full relist via an expired history id.
  it("aliases that arrive later rewrite no stored page", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      const id = await connected(db.storage);
      const w = world();
      expect((await run(db.storage, gmailFetch(w), id)).status).toBe("success");
      const before = (await e.query<{ slug: string; markdown_body: string; content_hash: string }>(
        `SELECT slug, markdown_body, content_hash FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [SOURCE])).rows;
      expect(before).toHaveLength(4);

      w.sendAs = { status: 200, body: { sendAs: [{ sendAsEmail: ALIAS }, { sendAsEmail: "bob@example.org" }] } };
      w.history = start => (start === "120000" ? { status: 404, body: GMAIL_FIXTURES.error404History } : "historyEmpty");
      w.profile = "profileAfterExpiry";
      const result = await run(db.storage, gmailFetch(w), id, T0 + DAY);
      expect(result.status).toBe("success");
      expect((await config(e, id)).sendas_aliases).toEqual([ALIAS, "bob@example.org"]);
      expect(result.counts.pages_written).toBe(0);
      expect(result.counts.pages_unchanged).toBe(4);
      const after = (await e.query<{ slug: string; markdown_body: string; content_hash: string }>(
        `SELECT slug, markdown_body, content_hash FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`, [SOURCE])).rows;
      expect(after).toEqual(before);
      expect(Number((await e.query<{ n: number }>(`SELECT count(*)::int AS n FROM connector_items WHERE account_id = $1`, [id])).rows[0]!.n)).toBe(4);
    } finally { await db.close(); }
  });
});
