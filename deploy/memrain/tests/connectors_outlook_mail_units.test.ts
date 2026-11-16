/**
 * Outlook message reading without a database: every MailMessage field the
 * open-loop detector reads is filled from the Graph resource (Sent Items as
 * `sent`, Reply-To, Auto-Submitted / Precedence / List-Id from the internet
 * headers, a meeting message's METHOD), drafts and other folders are left out
 * of a conversation, a cursor this version cannot read is treated as none; a
 * golden check that an Outlook conversation and the equivalent Gmail thread
 * render the same page but for where they came from; and 90 days of a typical
 * mailbox embed for well under an account's default daily cap.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { plainMessage } from "./helpers/gmail-fake.ts";
import { FOLDERS, fixtureMessages, type GraphMessage } from "./helpers/outlook-mail-fake.ts";
import { normalizeGmailThread } from "../src/core/connectors/google/gmail.ts";
import { normalizeOutlookConversation, normalizeOutlookMessage, parseOutlookMailCursor } from "../src/core/connectors/microsoft/mail.ts";
import { renderMailThread } from "../src/core/connectors/render.ts";
import { accountRef } from "../src/core/connectors/model.ts";
import { costUsd } from "../src/core/budget.ts";
import { DEFAULT_MODEL_ID } from "../src/core/embedding.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;
const OWNER = "owner@example.test";
const FOLDER_SET = { included: new Set([FOLDERS.inbox!, FOLDERS.sentitems!]), sent: new Set([FOLDERS.sentitems!]) };
const byId = (id: string) => fixtureMessages().find(m => m.id === id)! as GraphMessage;
const one = (m: GraphMessage) => normalizeOutlookMessage(m, FOLDER_SET.sent);

describe("outlook message reading", () => {
  it("fills the reply-state fields the loop detector reads", () => {
    expect(one(byId("o1"))).toMatchObject({ sent: true, from: { name: "Owner", email: "owner.alias@example.org" }, replyTo: [], calendarMethod: null });
    expect(one(byId("b1"))).toMatchObject({ sent: false, listUnsubscribe: true, listId: true, precedence: "bulk", autoSubmitted: false });
    expect(one(byId("r1"))).toMatchObject({ sent: false, replyTo: ["no-reply@survey.example"], autoSubmitted: false });
    expect(one(byId("i1"))).toMatchObject({ calendarMethod: "REQUEST" });
    expect(one({ ...byId("e1"), internetMessageHeaders: [{ name: "Auto-Submitted", value: "auto-replied" }] })).toMatchObject({ autoSubmitted: true });
    expect(one({ ...byId("e1"), "@odata.type": "#microsoft.graph.eventMessageResponse" })).toMatchObject({ calendarMethod: "REPLY" });
    expect(one({ ...byId("e1"), "@odata.type": "#microsoft.graph.eventMessage" })).toMatchObject({ calendarMethod: "CANCEL" });
    expect(one(byId("a1"))).toMatchObject({
      messageIdHeader: "<a1@example.net>", subject: "Q4 budget", from: { name: "Ana Lee", email: "ana@example.net" },
      to: [{ name: "Owner", email: OWNER }], cc: [{ name: "Stone, Bob", email: "bob@example.org" }],
      date: "2026-11-06T10:00:00.000Z", bodyHtml: null, categories: ["red category"], sent: false,
    });
    expect(one(byId("a2")).attachments).toEqual([{ name: "budget-q4.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 18432 }]);
  });

  it("reads an html body as html and keeps no attachment handle or content", () => {
    const m = one({ ...byId("a2"), body: { contentType: "html", content: "<p>hi</p>" } });
    expect(m).toMatchObject({ bodyText: null, bodyHtml: "<p>hi</p>" });
    expect(JSON.stringify(m)).not.toContain("att-1");
  });

  it("keeps a conversation's messages from the synced folders only, drafts and older-than-floor mail out", () => {
    const conv = fixtureMessages().filter(m => m.conversationId === "conv-A");
    const n = normalizeOutlookConversation("conv-A", conv, { ...FOLDER_SET, floorMs: null })!;
    expect(n.thread.messages.map(m => m.id)).toEqual(["a1", "a2"]);
    expect(n.thread.labels).toEqual(["Red category"]);
    expect(normalizeOutlookConversation("conv-E", fixtureMessages().filter(m => m.id === "e2"), { ...FOLDER_SET, floorMs: null })).toBeNull();
    expect(normalizeOutlookConversation("conv-A", conv, { ...FOLDER_SET, floorMs: T0 - 9 * DAY })).toBeNull();
    // The version moves when a kept message changes, and not for a dropped one.
    const v1 = n.version;
    const edited = conv.map(m => (m.id === "a3" ? { ...m, changeKey: "other" } : m));
    expect(normalizeOutlookConversation("conv-A", edited, { ...FOLDER_SET, floorMs: null })!.version).toBe(v1);
    const read = conv.map(m => (m.id === "a1" ? { ...m, changeKey: "other" } : m));
    expect(normalizeOutlookConversation("conv-A", read, { ...FOLDER_SET, floorMs: null })!.version).not.toBe(v1);
  });

  it("reads a malformed or foreign cursor as none", () => {
    for (const bad of ["{", "[]", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, floorMs: -1, link: null, linkKind: null, pending: null }),
      JSON.stringify({ v: 1, floorMs: 1, link: "https://evil.example/v1.0/x", linkKind: "next", pending: null }),
      JSON.stringify({ v: 1, floorMs: 1, link: "/v1.0/x", linkKind: "sideways", pending: null })]) {
      expect(parseOutlookMailCursor(bad)).toBeNull();
    }
    expect(parseOutlookMailCursor(JSON.stringify({ v: 1, floorMs: 5, link: "/v1.0/me/mailFolders('x')/messages/delta?$deltatoken=t", linkKind: "delta", pending: null })))
      .toEqual({ v: 1, floorMs: 5, link: "/v1.0/me/mailFolders('x')/messages/delta?$deltatoken=t", linkKind: "delta", pending: null });
  });
});

describe("outlook and gmail render alike", () => {
  it("an Outlook conversation renders the same page as the equivalent Gmail thread, but for its origin", () => {
    const conv = fixtureMessages().filter(m => m.conversationId === "conv-A");
    const outlook = normalizeOutlookConversation("conv-A", conv, { ...FOLDER_SET, floorMs: null })!.thread;
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const g1 = plainMessage("g1", "gt", T0 - 10 * DAY, { "From": "Ana Lee <Ana@Example.net>", "To": `Owner <${OWNER}>`, "Cc": "\"Stone, Bob\" <bob@example.org>", "Subject": "Q4 budget", "Message-ID": "<a1@example.net>" },
      "Hi,\n\nCan you send the Q4 budget by Friday?\n\nAna");
    const g2 = plainMessage("g2", "gt", T0 - 10 * DAY + 2 * 3_600_000, { "From": `Owner <${OWNER}>`, "To": "Ana Lee <ana@example.net>", "Subject": "RE: Q4 budget", "Message-ID": "<a2@example.net>" }, "", ["SENT"]);
    g2.payload = {
      mimeType: "multipart/mixed",
      headers: g2.payload.headers,
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from((conv.find(m => m.id === "a2")!.body as { content: string }).content).toString("base64url") } },
        { mimeType: xlsx, filename: "budget-q4.xlsx", body: { attachmentId: "x", size: 18432 } },
      ],
    };
    const gmail = normalizeGmailThread("gt", [g1, g2])!.thread;
    const o = renderMailThread({ service: "outlook_mail", accountLabel: OWNER }, outlook);
    const g = renderMailThread({ service: "gmail", accountLabel: OWNER }, gmail);
    expect(o.body).toBe(g.body);
    expect(o.title).toBe(g.title);
    expect({ bulk: o.bulk, kind: o.kind, occurredAt: o.occurredAt, participants: o.participants })
      .toEqual({ bulk: g.bulk, kind: g.kind, occurredAt: g.occurredAt, participants: g.participants });
    const strip = (t: Record<string, unknown>) => {
      const { connector: _c, external_id: _x, labels: _l, account: _a, ...rest } = t;
      return rest;
    };
    expect(strip(o.truth)).toEqual(strip(g.truth));
    expect(o.truth.connector).toBe("outlook_mail");
    // Each provider's copy belongs to its own account: same month, its own owner ref.
    expect([o.truth.account, g.truth.account]).toEqual([accountRef(OWNER, "microsoft"), accountRef(OWNER, "google")]);
    const [oKind, oAccount, oMonth] = o.slug.split("/");
    const [gKind, gAccount, gMonth] = g.slug.split("/");
    expect([oKind, oMonth]).toEqual([gKind, gMonth]);
    expect([oAccount, gAccount]).toEqual([accountRef(OWNER, "microsoft"), accountRef(OWNER, "google")]);
  });
});

/**
 * A typical work mailbox, seeded: 35 conversations a day for 90 days, most a
 * short exchange that quotes the previous message, one in five a newsletter
 * of a few kilobytes of text.
 */
function typicalMailbox(): GraphMessage[][] {
  let seed = 11;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const words = (n: number) => Array.from({ length: n }, () => ["budget", "meeting", "review", "draft", "client", "plan", "today", "thanks"][Math.floor(rand() * 8)]).join(" ");
  const who = (address: string) => ({ emailAddress: { name: null, address } });
  const convs: GraphMessage[][] = [];
  for (let d = 0; d < 90; d++) {
    for (let t = 0; t < 35; t++) {
      const conv = `c${d}-${t}`;
      const at = T0 - d * DAY - t * 600_000;
      const base = { conversationId: conv, isDraft: false, toRecipients: [who(OWNER)], ccRecipients: [], replyTo: [], categories: [] };
      if (rand() < 0.2) {
        convs.push([{ ...base, id: `${conv}a`, parentFolderId: FOLDERS.inbox!, receivedDateTime: new Date(at).toISOString(), subject: "News", from: who("news@shop.example"),
          internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<x>" }], body: { contentType: "text", content: Array.from({ length: 40 }, () => words(18)).join("\n\n") } }]);
        continue;
      }
      const msgs: GraphMessage[] = [];
      let quoted = "";
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const own = words(60 + Math.floor(rand() * 140));
        msgs.push({ ...base, id: `${conv}m${i}`, parentFolderId: i % 2 ? FOLDERS.sentitems! : FOLDERS.inbox!, receivedDateTime: new Date(at + i * 3_600_000).toISOString(),
          subject: "RE: plan", from: who(i % 2 ? OWNER : "peer@example.net"),
          body: { contentType: "text", content: `${own}\r\n\r\nOn Mon, 2 Nov 2026 at 10:00, Peer <peer@example.net> wrote:\r\n${quoted.split("\n").map(l => `> ${l}`).join("\r\n")}` } });
        quoted = own;
      }
      convs.push(msgs);
    }
  }
  return convs;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`outlook backfill cost (${name})`, () => {
  it("embeds 90 days of a typical mailbox for well under the account's default daily cap", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "outlook", kind: "mailbox", pathPrefix: "mail/" });
      const account = await createAccount(e, { sourceId: "outlook", provider: "microsoft", services: ["outlook_mail"], principalRef: "admin:operator", accountLabel: `owner-${randomBytes(2).toString("hex")}@example.test` });
      const cap = account.spend_cap_usd_daily;
      expect(cap).toBe(1);

      let bytes = 0;
      let pages = 0;
      for (const msgs of typicalMailbox()) {
        const n = normalizeOutlookConversation(msgs[0]!.conversationId, msgs, { ...FOLDER_SET, floorMs: T0 - 91 * DAY });
        if (n === null) continue;
        const page = renderMailThread({ service: "outlook_mail", accountLabel: account.account_label }, n.thread);
        bytes += Buffer.byteLength(page.title) + Buffer.byteLength(page.body);
        pages++;
      }
      expect(pages).toBe(90 * 35);
      // Three bytes a token is pessimistic for English mail, and chunk overlap
      // and contextual headers are charged at half as much again.
      const tokens = Math.ceil((bytes / 3) * 1.5);
      const usd = costUsd(DEFAULT_MODEL_ID, { inputTokens: tokens, outputTokens: 0 });
      expect(usd).toBeGreaterThan(0);
      expect(usd).toBeLessThan(cap / 4);
    } finally { await db.close(); }
  });
});
