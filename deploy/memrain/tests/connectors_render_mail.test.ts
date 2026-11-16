/**
 * Mail thread rendering details the Gmail connector relies on: quoted history
 * and signatures cut deterministically (a forward is kept whole), a bounded
 * body per message, machine mail (auto-replies, bulk precedence, mailing
 * lists) marked bulk so nobody is linked from it, and the thread's labels in
 * its compiled truth.
 */
import { describe, expect, it } from "bun:test";
import type { MailMessage, MailThread } from "../src/core/connectors/model.ts";
import { MAX_MAIL_MESSAGE_CHARS, renderMailThread, trimMailBody } from "../src/core/connectors/render.ts";

const ACCOUNT = "owner@example.org";

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: "m1", messageIdHeader: "<a1@example.net>", subject: "Plan", from: { name: "Bob", email: "bob@example.net" },
  to: [{ name: null, email: ACCOUNT }], cc: [], date: "2026-10-03T09:00:00.000Z", bodyText: "Hello.", bodyHtml: null,
  attachments: [], listUnsubscribe: false, categories: [], ...over,
});
const thread = (messages: MailMessage[], over: Partial<MailThread> = {}): MailThread => ({ threadId: "thr-1", messages, ...over });

describe("trimMailBody", () => {
  it("cuts the reply marker and everything after it, even when the quote is not prefixed", () => {
    const body = "Sounds good.\n\nOn Mon, 2 Nov 2026 at 10:00, Ana Lee <ana@example.net> wrote:\nOld text without a quote mark\n> and quoted";
    expect(trimMailBody(body)).toBe("Sounds good.");
  });

  it("cuts an Outlook-style original message block", () => {
    expect(trimMailBody("Yes.\n\n-----Original Message-----\nFrom: Ana\nSent: Monday\nOld")).toBe("Yes.");
  });

  it("keeps a forwarded message whole, since its text is new to the brain", () => {
    const body = "FYI\n\n---------- Forwarded message ---------\nFrom: Ana <ana@example.net>\nThe forwarded text";
    expect(trimMailBody(body)).toBe(body);
  });

  it("still drops a signature and trailing quoted lines", () => {
    expect(trimMailBody("Hi\n> quoted\n-- \nBob | Sales")).toBe("Hi");
  });

  it("drops a client's sent-from footer at the end of a message", () => {
    expect(trimMailBody("See you at 10.\n\nSent from my iPhone")).toBe("See you at 10.");
    expect(trimMailBody("Done.\n\nGet Outlook for Android")).toBe("Done.");
    expect(trimMailBody("Ok\n\nSent from Mail for Windows\n")).toBe("Ok");
  });

  it("keeps a sent-from line that is the message's own text, not its footer", () => {
    expect(trimMailBody("Sent from my iPhone, so excuse typos: the deal is off.")).toBe("Sent from my iPhone, so excuse typos: the deal is off.");
    expect(trimMailBody("Sent from my iPhone\n\nThe real reply comes here.")).toBe("Sent from my iPhone\n\nThe real reply comes here.");
  });
});

describe("renderMailThread", () => {
  it("bounds each message's body and says so", () => {
    const page = renderMailThread({ service: "gmail", accountLabel: ACCOUNT }, thread([message({ bodyText: "x".repeat(MAX_MAIL_MESSAGE_CHARS + 5000) })]));
    expect(page.body).toContain("[message truncated]");
    expect(page.body.length).toBeLessThan(MAX_MAIL_MESSAGE_CHARS + 2000);
  });

  it("marks auto-replies, bulk precedence and mailing lists as bulk", () => {
    const ctx = { service: "gmail" as const, accountLabel: ACCOUNT };
    expect(renderMailThread(ctx, thread([message({ autoSubmitted: true })])).bulk).toBe(true);
    expect(renderMailThread(ctx, thread([message({ precedence: "bulk" })])).bulk).toBe(true);
    expect(renderMailThread(ctx, thread([message({ precedence: "list" })])).bulk).toBe(true);
    expect(renderMailThread(ctx, thread([message({ listId: true })])).bulk).toBe(true);
    expect(renderMailThread(ctx, thread([message({ precedence: "first-class" })])).bulk).toBe(false);
  });

  it("marks mail from machine senders as bulk, and keeps a person whose address only resembles one", () => {
    const ctx = { service: "gmail" as const, accountLabel: ACCOUNT };
    const from = (email: string) => renderMailThread(ctx, thread([message({ from: { name: null, email } })])).bulk;
    for (const email of ["postmaster@example.net", "billing-noreply@example.net", "donotreply@example.net", "calendar-notification@google.com",
      "alerts_no_reply@example.net", "ne-pas-repondre@example.fr", "keine.antwort@example.de", "notificaciones@example.es", "gemini-notes@google.com"]) {
      expect([email, from(email)]).toEqual([email, true]);
    }
    for (const email of ["noelle@example.net", "postman.pat@example.net", "ana@example.net", "pat@postmaster.example", "ana@noreply-press.example", "lee@notifications.example"]) {
      expect([email, from(email)]).toEqual([email, false]);
    }
  });

  it("puts the thread's labels in its truth, sorted and lowercased", () => {
    const page = renderMailThread({ service: "gmail", accountLabel: ACCOUNT }, thread([message()], { labels: ["SENT", "INBOX", "Label_7"] }));
    expect(page.truth.labels).toEqual(["inbox", "label_7", "sent"]);
    expect(renderMailThread({ service: "gmail", accountLabel: ACCOUNT }, thread([message()])).truth.labels).toBeUndefined();
  });

  it("appends newer messages after older ones, whatever order they arrive in", () => {
    const page = renderMailThread({ service: "gmail", accountLabel: ACCOUNT }, thread([
      message({ id: "m2", date: "2026-10-04T09:00:00.000Z", bodyText: "Second." }),
      message({ id: "m1", date: "2026-10-03T09:00:00.000Z", bodyText: "First." }),
    ]));
    expect(page.body.indexOf("First.")).toBeLessThan(page.body.indexOf("Second."));
  });
});
