/**
 * Gmail message reading and the backfill's cost: address headers with quoted
 * commas, the text body never taken from inside an attachment, receipts for
 * attachments and invites, threads left out when only drafts, spam, trash or
 * bulk categories remain, a cursor this version cannot read treated as none,
 * and 90 days of a typical mailbox embedding for well under an account's
 * default daily cap.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { storageEngines } from "./helpers/storage-engines.ts";
import { attachmentReceipts, extractBody, isAutoSubmitted, parseAddressList, type GmailMimePart } from "../src/core/connectors/google/gmail-mime.ts";
import { normalizeGmailThread, parseGmailCursor } from "../src/core/connectors/google/gmail.ts";
import { renderMailThread } from "../src/core/connectors/render.ts";
import { costUsd } from "../src/core/budget.ts";
import { DEFAULT_MODEL_ID } from "../src/core/embedding.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount } from "../src/core/connectors/accounts.ts";
import { plainMessage, type RawMessage } from "./helpers/gmail-fake.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const T0 = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;

describe("gmail message reading", () => {
  it("parses address lists with quoted commas and display names", () => {
    expect(parseAddressList(`"Stone, Bob" <Bob@Example.org>, ana@example.net, Carol <carol@example.com>`)).toEqual([
      { name: "Stone, Bob", email: "bob@example.org" },
      { name: null, email: "ana@example.net" },
      { name: "Carol", email: "carol@example.com" },
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  it("takes the body from the message, not from a forwarded message attached to it", () => {
    const root: GmailMimePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "message/rfc822", filename: "", parts: [{ mimeType: "text/plain", body: { data: b64("attached text") } }] },
        { mimeType: "text/html", body: { data: b64("<p>own html</p>") } },
      ],
    };
    expect(extractBody(root)).toEqual({ text: "<p>own html</p>", isHtml: true });
  });

  it("keeps every inline text part of a mixed message, in order, and the plain alternative over its html", () => {
    const root: GmailMimePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: b64("first part") } },
          { mimeType: "text/html", body: { data: b64("<p>first part</p>") } },
        ] },
        { mimeType: "image/png", filename: "", headers: [{ name: "Content-Disposition", value: "inline" }], body: { attachmentId: "img", size: 10 } },
        { mimeType: "text/plain", body: { data: b64("second part") } },
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attached notes") } },
      ],
    };
    expect(extractBody(root)).toEqual({ text: "first part\n\nsecond part", isHtml: false });
  });

  it("describes attachments and invites by name, type and size, never their handle", () => {
    const root: GmailMimePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("hi") } },
        { mimeType: "application/pdf", filename: "deck.pdf", body: { attachmentId: "handle-1", size: 2048 } },
        { mimeType: "text/calendar; method=REQUEST", body: { size: 900 } },
      ],
    };
    const receipts = attachmentReceipts(root);
    expect(receipts).toEqual([{ name: "deck.pdf", mime: "application/pdf", size: 2048 }, { name: "(unnamed)", mime: "text/calendar", size: 900 }]);
    expect(JSON.stringify(receipts)).not.toContain("handle-1");
  });

  it("reads RFC 3834 Auto-Submitted", () => {
    expect(isAutoSubmitted("auto-replied")).toBe(true);
    expect(isAutoSubmitted("auto-generated (bot)")).toBe(true);
    expect(isAutoSubmitted("no")).toBe(false);
    expect(isAutoSubmitted("")).toBe(false);
  });

  it("leaves out a thread of drafts, spam or trash, and one wholly in Promotions or Social", () => {
    const m = (id: string, labels: string[]) => plainMessage(id, "t", T0, { From: "a@example.net" }, "x", labels);
    expect(normalizeGmailThread("t", [m("1", ["DRAFT"]), m("2", ["TRASH"])])).toBeNull();
    expect(normalizeGmailThread("t", [m("1", ["CATEGORY_PROMOTIONS"]), m("2", ["CATEGORY_SOCIAL", "INBOX"])])).toBeNull();
    const kept = normalizeGmailThread("t", [m("1", ["CATEGORY_PROMOTIONS"]), m("2", ["SENT"]), m("3", ["SPAM"])])!;
    expect(kept.thread.messages.map(x => x.id)).toEqual(["1", "2"]);
    expect(kept.thread.labels).toEqual(["CATEGORY_PROMOTIONS", "SENT"]);
  });

  it("reads a malformed or foreign cursor as none", () => {
    for (const bad of ["{", "[]", JSON.stringify({ v: 2 }), JSON.stringify({ v: 1, historyId: 5, historyPage: null, walk: null }),
      JSON.stringify({ v: 1, historyId: "1", historyPage: null, walk: { lowMs: -1, queryFloorMs: 1, resumeFloorMs: 1, pageToken: null } })]) {
      expect(parseGmailCursor(bad)).toBeNull();
    }
    expect(parseGmailCursor(JSON.stringify({ v: 1, historyId: "9", historyPage: null, walk: null }))).toEqual({ v: 1, historyId: "9", historyPage: null, pending: null, floorMs: null, walk: null });
  });
});

/**
 * A typical personal mailbox, seeded: 35 threads a day for 90 days, most a
 * short exchange that quotes the previous message, one in five a newsletter
 * of a few kilobytes of HTML.
 */
function typicalMailbox(): RawMessage[][] {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const words = (n: number) => Array.from({ length: n }, () => ["budget", "meeting", "review", "draft", "client", "plan", "today", "thanks"][Math.floor(rand() * 8)]).join(" ");
  const threads: RawMessage[][] = [];
  for (let d = 0; d < 90; d++) {
    for (let t = 0; t < 35; t++) {
      const tid = `t${d}-${t}`;
      const at = T0 - d * DAY - t * 600_000;
      if (rand() < 0.2) {
        const html = `<html><body>${Array.from({ length: 40 }, () => `<p>${words(18)}</p>`).join("")}</body></html>`;
        threads.push([{ ...plainMessage(`${tid}a`, tid, at, { From: "news@shop.example", "List-Unsubscribe": "<x>" }, ""), payload: { mimeType: "text/html", body: { data: b64(html) } } }]);
        continue;
      }
      const msgs: RawMessage[] = [];
      let quoted = "";
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const own = words(60 + Math.floor(rand() * 140));
        msgs.push(plainMessage(`${tid}m${i}`, tid, at + i * 3_600_000, { From: i % 2 ? "me@example.test" : "peer@example.net", Subject: "Re: plan" },
          `${own}\n\nOn Mon, 2 Nov 2026 at 10:00, Peer <peer@example.net> wrote:\n${quoted.split("\n").map(l => `> ${l}`).join("\n")}`));
        quoted = own;
      }
      threads.push(msgs);
    }
  }
  return threads;
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`gmail backfill cost (${name})`, () => {
  it("embeds 90 days of a typical mailbox for well under the account's default daily cap", async () => {
    const db = await open();
    try {
      const e = db.storage.engine();
      await registerSource(e, { id: "mail", kind: "mailbox", pathPrefix: "mail/" });
      const account = await createAccount(e, { sourceId: "mail", provider: "google", services: ["gmail"], principalRef: "admin:operator", accountLabel: `owner-${randomBytes(2).toString("hex")}@example.test` });
      const cap = account.spend_cap_usd_daily;
      expect(cap).toBe(1);

      let bytes = 0;
      let pages = 0;
      for (const msgs of typicalMailbox()) {
        const n = normalizeGmailThread(msgs[0]!.threadId, msgs);
        if (n === null) continue;
        const page = renderMailThread({ service: "gmail", accountLabel: account.account_label }, n.thread);
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
