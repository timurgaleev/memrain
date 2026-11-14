/**
 * The admin SPA's notification helpers (admin/src/lib/notifications.ts and the
 * route): the badge text, the kind labels and the `#notifications/<id>` link
 * the webhook and the API hand out. Pure modules, no DOM.
 */
import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import { actionPage, badgeText, kindLabel, linkedNotificationId } from "../admin/src/lib/notifications.ts";
import { NOTIFICATION_KINDS, notificationLink } from "../src/core/notifications/store.ts";

describe("notifications route", () => {
  it("parses the link the server hands out", () => {
    const hash = notificationLink(42).slice(notificationLink(42).indexOf("#"));
    expect(parseHash(hash)).toEqual({ name: "notifications", param: "42" });
    expect(parseHash("#notifications")).toEqual({ name: "notifications", param: null });
    expect(buildHash({ name: "notifications", param: null })).toBe("#notifications");
  });

  it("reads only a positive integer id from the route", () => {
    expect(linkedNotificationId("42")).toBe(42);
    for (const p of [null, "", "0", "-1", "4.2", "1e3", "42abc", "9".repeat(20)]) expect(linkedNotificationId(p)).toBeNull();
  });
});

describe("badgeText", () => {
  it("counts unread open notifications, capped for the sidebar", () => {
    expect(badgeText({ open: 0, unread: 0 })).toBe("");
    expect(badgeText({ open: 3, unread: 0 })).toBe("");
    expect(badgeText({ open: 3, unread: 2 })).toBe("2");
    expect(badgeText({ open: 120, unread: 120 })).toBe("99+");
  });

  it("shows nothing for a missing or malformed summary", () => {
    expect(badgeText(null)).toBe("");
    expect(badgeText({ open: 1, unread: Number.NaN })).toBe("");
  });
});

describe("kindLabel", () => {
  it("names every kind the server can send", () => {
    for (const k of NOTIFICATION_KINDS) expect(kindLabel(k)).not.toBe(k);
  });

  it("falls back to the raw kind for one it does not know", () => {
    expect(kindLabel("something_new")).toBe("something_new");
  });
});

describe("actionPage", () => {
  it("sends each kind to the admin page where its action lives", () => {
    expect(actionPage("needs_reconnect")).toBe("connections");
    expect(actionPage("deletions_held")).toBe("connections");
    expect(actionPage("items_held")).toBe("connections");
    expect(actionPage("write_gate_hold")).toBe("approvals");
    expect(actionPage("spend_path_paused")).toBe("autonomy");
    expect(actionPage("daemon_auto_paused")).toBe("autonomy");
    for (const k of NOTIFICATION_KINDS) {
      const page = actionPage(k)!;
      expect(parseHash(buildHash({ name: page, param: null })).name).toBe(page);
    }
  });

  it("has no page for a kind it does not know", () => {
    expect(actionPage("something_new")).toBeNull();
  });
});
