/**
 * The admin SPA's pure helpers for the Connections, Autonomy and Approvals
 * pages (admin/src/lib/automation.ts): what an account's state means and
 * which actions it allows, the typed-name confirmation, which sources a
 * service can feed, the outcome a finished connect reports, and how a daemon
 * and a write-gate decision read. No DOM.
 */
import { describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import {
  accountView,
  clientRejectedNote,
  confirmMatches,
  connectOutcome,
  connectorErrorCopy,
  daemonView,
  decisionMessage,
  deleteOutcome,
  disconnectConsentNote,
  exclusiveServices,
  grantNote,
  hasCalendarPicker,
  lastRunText,
  providerLabel,
  initialServices,
  safeAuthorizeUrl,
  serviceLabel,
  sourcesFor,
  tenantChangeEffect,
  tenantChoice,
  tenantFromForm,
  toggleService,
  type ConnectorAccountView,
  type DaemonView,
} from "../admin/src/lib/automation.ts";

const base: ConnectorAccountView = {
  id: "a1", source_id: "inbox", provider: "google", services: ["calendar"], account_label: "owner@example.test",
  status: "active", status_reason: null, enabled: false, spend_cap_usd_daily: 1, item_cap_daily: 5000,
  last_success_at: null, held_items: 0, held_deletes: 0, notices: [],
  credential: { scopes: ["calendar.readonly"], expires_at: null, granted_at: "2026-11-09T10:00:00.000Z" },
  last_run: null, needs_reconnect: false, grant_expiry: null,
};

describe("lastRunText", () => {
  it("says how the last run ended and what it read, or that none ran yet", () => {
    expect(lastRunText(null)).toBe("none yet");
    expect(lastRunText({ status: "success", stop_reason: null, at: "x", http_status: null, error: null, items: 12, pages_written: 3, items_failed: 0 }))
      .toBe("success · 12 items, 3 written");
    expect(lastRunText({ status: "partial", stop_reason: "fetch_failed", at: "x", http_status: 429, error: "rate", items: 4, pages_written: 1, items_failed: 2 }))
      .toBe("partial (fetch_failed, HTTP 429) · 4 items, 1 written, 2 failed");
  });
});

describe("grantNote", () => {
  const upcoming = { granted_at: "2026-11-09T10:00:00.000Z", expires_at: "2026-11-16T10:00:00.000Z", days: 7, state: "upcoming" as const, due_soon: false };
  it("names the expected end of a Testing-mode grant, and asks for a reconnect once it is close", () => {
    expect(grantNote(base)).toBeNull();
    expect(grantNote({ ...base, grant_expiry: upcoming })).toEqual({
      warn: false, text: "Around 2026-11-16 if the Google app is in Testing (7 days after consent).",
    });
    const soon = grantNote({ ...base, grant_expiry: { ...upcoming, due_soon: true } })!;
    expect(soon.warn).toBe(true);
    expect(soon.text).toContain("Reconnect before then");
  });

  it("explains a reconnect the Testing-mode limit likely caused", () => {
    const lapsed = grantNote({ ...base, status: "needs_reconnect", needs_reconnect: true, grant_expiry: { ...upcoming, state: "lapsed" } })!;
    expect(lapsed.warn).toBe(true);
    expect(lapsed.text).toContain("7 days after consent");
    expect(lapsed.text).toContain("publish the app");
  });
});

describe("grantNote for Microsoft", () => {
  const NOW = Date.parse("2026-11-09T12:00:00Z");
  const ms: ConnectorAccountView = {
    ...base, provider: "microsoft", services: ["outlook_mail"], enabled: false,
    credential: { scopes: ["Mail.Read"], expires_at: null, granted_at: "2026-10-01T12:00:00.000Z" },
  };

  it("says nothing while the account syncs, since every sync renews the grant", () => {
    expect(grantNote({ ...ms, enabled: true, last_success_at: "2026-11-09T11:00:00Z" }, NOW)).toBeNull();
  });

  it("still warns when sync is on but nothing has run for weeks (the scheduler is off or paused)", () => {
    const stalled = grantNote({ ...ms, enabled: true, last_success_at: "2026-08-20T10:00:00Z",
      credential: { ...ms.credential!, granted_at: "2026-08-10T12:00:00.000Z" } }, NOW)!;
    expect(stalled.warn).toBe(true);
    expect(stalled.text).toContain("has not synced since 2026-08-20");
    expect(stalled.text).toContain("2026-11-18");
  });

  it("names the day 90 unused days end a grant whose sync is off, counting from its last use", () => {
    expect(grantNote(ms, NOW)).toEqual({
      warn: false,
      text: "Around 2026-12-30: Microsoft ends access that goes unused for 90 days, and sync is off. Turn sync on to keep it renewed.",
    });
    // A clean sync after the consent is the later use.
    expect(grantNote({ ...ms, last_success_at: "2026-10-20T08:00:00Z" }, NOW)!.text).toContain("2027-01-18");
  });

  it("warns from 15 days before the end, and explains a reconnect that 90 unused days likely caused", () => {
    const soon = grantNote({ ...ms, credential: { ...ms.credential!, granted_at: "2026-08-20T12:00:00.000Z" } }, NOW)!;
    expect(soon.warn).toBe(true);
    expect(soon.text).toContain("2026-11-18");
    expect(soon.text).toContain("Turn sync on or reconnect");
    const lapsed = grantNote({ ...ms, status: "needs_reconnect", needs_reconnect: true,
      credential: { ...ms.credential!, granted_at: "2026-07-01T12:00:00.000Z" } }, NOW)!;
    expect(lapsed.warn).toBe(true);
    expect(lapsed.text).toContain("unused for 90 days");
    // A refusal well inside the 90 days has another cause: the notice says which.
    expect(grantNote({ ...ms, status: "needs_reconnect", needs_reconnect: true }, NOW)).toBeNull();
  });

  it("has nothing to say about an account without a credential", () => {
    expect(grantNote({ ...ms, status: "revoked", credential: null }, NOW)).toBeNull();
  });
});

describe("Microsoft service labels and the tenant field", () => {
  it("names each service as the owner knows it, and keeps an unknown one as it is", () => {
    expect(serviceLabel("microsoft", "outlook_mail")).toBe("Outlook mail");
    expect(serviceLabel("microsoft", "outlook_calendar")).toBe("Outlook calendar");
    expect(serviceLabel("google", "gmail")).toBe("Gmail");
    expect(serviceLabel("google", "calendar")).toBe("Google Calendar");
    expect(serviceLabel("slack", "channels")).toBe("channels");
  });

  it("offers services as a single choice when no one source can hold two of them", () => {
    expect(exclusiveServices({ services: ["mail", "calendar"], service_kinds: { mail: ["mailbox"], calendar: ["calendar"] } })).toBe(true);
    expect(exclusiveServices({ services: ["a", "b"], service_kinds: { a: ["chat"], b: ["chat"] } })).toBe(false);
  });

  it("reads a saved tenant as the choice it was, and a form back as the tenant to send", () => {
    expect(tenantChoice(null, "common")).toBe("common");
    expect(tenantChoice("consumers", "common")).toBe("consumers");
    expect(tenantChoice("contoso.onmicrosoft.com", "common")).toBe("tenant");
    expect(tenantFromForm("organizations", "")).toBe("organizations");
    expect(tenantFromForm("tenant", " Contoso.OnMicrosoft.com ")).toBe("contoso.onmicrosoft.com");
    expect(tenantFromForm("tenant", "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D")).toBe("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    for (const bad of ["", "contoso", "a/b.example", "x.example?y=1"]) expect(tenantFromForm("tenant", bad)).toBeNull();
  });

  it("says which accounts a new tenant turns away, and points mixed accounts at common", () => {
    const orgs = tenantChangeEffect("organizations");
    expect(orgs).toContain("Personal Microsoft accounts");
    expect(orgs).toContain("cannot reconnect");
    expect(orgs).toContain("keep Work, school and personal accounts (common)");
    expect(tenantChangeEffect("consumers")).toContain("Work and school accounts");
    const one = tenantChangeEffect("contoso.onmicrosoft.com");
    expect(one).toContain("contoso.onmicrosoft.com");
    expect(one).toContain("personal accounts and accounts of any other organization");
    const common = tenantChangeEffect("common");
    expect(common).toContain("can all sign in");
    expect(common).not.toContain("keep Work");
  });

  it("says what to do when a provider refused its OAuth app, by its codes only", () => {
    const since = "2026-11-16T10:00:00.000Z";
    const until = "2026-11-16T11:00:00.000Z";
    const expired = clientRejectedNote("microsoft", { reason: "invalid_client", service_code: 7000222, since, held_until: until })!;
    expect(expired).toContain("Microsoft refused your app");
    expect(expired).toContain("AADSTS7000222");
    expect(expired).toContain("save it with the same client ID");
    expect(expired).toContain("No reconnect");
    const google = clientRejectedNote("google", { reason: "invalid_client", service_code: null, since, held_until: until })!;
    expect(google).toContain("Google refused your app when renewing access (invalid_client)");
    expect(google).not.toContain("AADSTS");
    expect(clientRejectedNote("google", null)).toBeNull();
  });

  it("tells the owner where to remove a consent the provider cannot withdraw for us", () => {
    expect(disconnectConsentNote("google", true)).toBeNull();
    const ms = disconnectConsentNote("microsoft", false)!;
    expect(ms).toContain("account.microsoft.com/privacy/app-access");
    expect(ms).toContain("myapplications.microsoft.com");
    expect(ms).toContain("IT admin");
    expect(disconnectConsentNote("other", false)).toContain("the provider's own settings");
  });

  it("does not tell an owner who asked an administrator for approval that they cancelled", () => {
    const declined = connectorErrorCopy("consent_declined");
    expect(declined).toContain("asked an administrator");
    expect(declined).toContain("wait until");
    expect(declined).toContain("choose Accept");
    expect(connectorErrorCopy("admin_consent_required")).toContain("administrator");
  });

  it("explains a tenant the server refused", () => {
    expect(connectorErrorCopy("invalid_tenant")).toContain("directory ID");
    expect(connectorErrorCopy("tenant_unsupported")).toContain("does not take a tenant");
  });
});

describe("hasCalendarPicker", () => {
  it("offers the calendar picker for a connected Google Calendar account while connectors are on", () => {
    expect(hasCalendarPicker(base, true)).toBe(true);
    expect(hasCalendarPicker(base, false)).toBe(false);
    expect(hasCalendarPicker({ ...base, status: "needs_reconnect" }, true)).toBe(false);
    expect(hasCalendarPicker({ ...base, provider: "fireflies", services: ["fireflies"] }, true)).toBe(false);
    expect(hasCalendarPicker({ ...base, services: ["mail"] }, true)).toBe(false);
  });

  it("offers it for a connected Outlook calendar account too", () => {
    expect(hasCalendarPicker({ ...base, provider: "microsoft", services: ["outlook_calendar"] }, true)).toBe(true);
    expect(hasCalendarPicker({ ...base, provider: "microsoft" }, true)).toBe(false);
    expect(hasCalendarPicker({ ...base, provider: "microsoft", services: ["outlook_mail"] }, true)).toBe(false);
  });
});

describe("routes", () => {
  it("knows the three automation pages", () => {
    for (const name of ["connections", "autonomy", "approvals"] as const) {
      expect(parseHash(`#${name}`)).toEqual({ name, param: null });
      expect(buildHash({ name, param: null })).toBe(`#${name}`);
    }
  });
});

describe("accountView", () => {
  it("offers to switch sync on for a fresh, connected account and nothing destructive beyond a disconnect", () => {
    expect(accountView(base)).toMatchObject({
      tone: "idle", label: "Connected, sync off", canToggleSync: true, canReconnect: false, canDisconnect: true, canDeleteData: false,
    });
    expect(accountView({ ...base, enabled: true })).toMatchObject({ tone: "ok", label: "Syncing" });
  });

  it("asks for a reconnect when the provider refused the token, keeping the data", () => {
    const v = accountView({ ...base, enabled: true, status: "needs_reconnect", status_reason: "invalid_grant" });
    expect(v).toMatchObject({ tone: "warn", label: "Needs reconnect", canReconnect: true, canDisconnect: true, canDeleteData: false });
  });

  it("lets a disconnected account delete its data, and nothing else", () => {
    expect(accountView({ ...base, status: "revoked", credential: null })).toMatchObject({
      tone: "idle", label: "Disconnected", canToggleSync: false, canReconnect: false, canDisconnect: false, canDeleteData: true,
    });
    // The provider refused the revoke: the token is kept so the disconnect can be retried.
    expect(accountView({ ...base, status: "error", status_reason: "revoke_failed" })).toMatchObject({
      tone: "error", label: "Revoke failed", canDisconnect: true, canDeleteData: true, canToggleSync: false,
    });
  });

  it("names what is waiting on the owner", () => {
    expect(accountView({ ...base, held_deletes: 3, held_items: 2 }).attention).toEqual(["3 deletions held", "2 items held"]);
    expect(accountView({ ...base, held_deletes: 1, held_items: 1 }).attention).toEqual(["1 deletion held", "1 item held"]);
    expect(accountView(base).attention).toEqual([]);
  });
});

describe("confirmMatches", () => {
  it("needs the account name exactly, surrounding spaces aside", () => {
    expect(confirmMatches("owner@example.test", "owner@example.test")).toBe(true);
    expect(confirmMatches("  owner@example.test ", "owner@example.test")).toBe(true);
    expect(confirmMatches("OWNER@example.test", "owner@example.test")).toBe(false);
    expect(confirmMatches("owner@example", "owner@example.test")).toBe(false);
    expect(confirmMatches("", "owner@example.test")).toBe(false);
  });
});

describe("sourcesFor", () => {
  const sources = [{ id: "default", kind: "other" }, { id: "cal", kind: "calendar" }, { id: "inbox", kind: "mailbox" }];
  const kinds = { calendar: ["calendar"], mail: ["mailbox"] };
  it("keeps only the sources every chosen service may write into", () => {
    expect(sourcesFor(kinds, ["calendar"], sources).map((s) => s.id)).toEqual(["cal"]);
    expect(sourcesFor(kinds, ["mail"], sources).map((s) => s.id)).toEqual(["inbox"]);
    expect(sourcesFor(kinds, ["mail", "calendar"], sources)).toEqual([]);
    expect(sourcesFor(kinds, [], sources)).toEqual([]);
  });
});

describe("service picker", () => {
  const google = { services: ["calendar", "gmail"], service_kinds: { calendar: ["calendar"], gmail: ["mailbox"] } };
  it("starts with the first service only when no one source holds them all", () => {
    expect(initialServices(google)).toEqual(["calendar"]);
    expect(initialServices({ services: ["a", "b"], service_kinds: { a: ["chat"], b: ["chat"] } })).toEqual(["a", "b"]);
  });
  it("switching a service on drops the chosen ones no source could hold with it", () => {
    expect(toggleService(google, ["calendar"], "gmail", true)).toEqual(["gmail"]);
    expect(toggleService(google, ["gmail"], "gmail", false)).toEqual([]);
    const shared = { services: ["a", "b"], service_kinds: { a: ["chat"], b: ["chat"] } };
    expect(toggleService(shared, ["a"], "b", true)).toEqual(["a", "b"]);
  });
});

describe("connectOutcome", () => {
  it("reads the outcome a finished connect left in the query", () => {
    expect(connectOutcome("?connector=connected")).toEqual({ ok: true, message: "Account connected. Sync stays off until you switch it on." });
    expect(connectOutcome("?connector_error=state_expired")).toEqual({ ok: false, message: "The connect link expired. Start again." });
    expect(connectOutcome("?connector_error=scope_mismatch")?.message).toContain("different access");
    // A refused grant another connected account shares is left in place: the owner retries and allows everything.
    expect(connectOutcome("?connector_error=scope_mismatch_not_revoked")?.message).toContain("allow every access");
    expect(connectOutcome("?connector_error=scope_mismatch_not_revoked")?.message).toContain("Nothing was saved");
    expect(connectOutcome("?connector_error=identity_not_revoked")?.message).toContain("Nothing was saved");
    expect(connectOutcome("?connector=reconnected")).toEqual({ ok: true, message: "Account reconnected. Its pages and sync position were kept, and its sync stays on or off as it was." });
    expect(connectOutcome("")).toBeNull();
    expect(connectOutcome("?other=1")).toBeNull();
  });

  it("says when the connected account came with no address, and when another user signed in for a row", () => {
    const noted = connectOutcome("?connector=connected&connector_note=no_address")!;
    expect(noted.ok).toBe(true);
    expect(noted.message).toContain("Sync stays off");
    expect(noted.message).toContain("no email address");
    expect(connectOutcome("?connector=connected&connector_note=<b>")).toEqual({ ok: true, message: "Account connected. Sync stays off until you switch it on." });
    const mismatch = connectorErrorCopy("identity_mismatch");
    expect(mismatch).toContain("different account than the one this row belongs to");
    expect(mismatch).toContain("Nothing was changed");
  });

  it("explains why a pasted API key was not saved", () => {
    expect(connectorErrorCopy("key_rejected")).toContain("refused the key");
    expect(connectorErrorCopy("key_invalid")).toContain("does not look like an API key");
    expect(connectorErrorCopy("provider_unavailable")).toContain("could not be reached");
  });

  it("tells the owner a delete-all that stopped part-way can be finished", () => {
    expect(connectorErrorCopy("delete_incomplete")).toContain("Preview again");
  });

  it("never echoes an unknown code back as text", () => {
    const r = connectOutcome("?connector_error=%3Cscript%3E");
    expect(r).toEqual({ ok: false, message: "The connect did not finish. Start again." });
  });
});

describe("daemonView", () => {
  const d: DaemonView = {
    name: "connector_sync", enabled: true, env_disabled: false, paused: null, last_outcome: "succeeded", consecutive_failures: 0,
  };
  it("reads enabled, paused, switched off by the environment, and failing", () => {
    expect(daemonView(d, null)).toEqual({ tone: "ok", label: "On" });
    expect(daemonView({ ...d, enabled: false }, null)).toEqual({ tone: "idle", label: "Off" });
    expect(daemonView({ ...d, env_disabled: true }, null)).toEqual({ tone: "idle", label: "Off (environment)" });
    expect(daemonView({ ...d, paused: { by: "operator", reason: "noisy", at: null } }, null)).toEqual({ tone: "warn", label: "Paused by operator" });
    expect(daemonView({ ...d, consecutive_failures: 5 }, null)).toEqual({ tone: "error", label: "Failing (5 in a row)" });
    expect(daemonView(d, { by: "admin", reason: null, at: null })).toEqual({ tone: "warn", label: "Paused (all daemons)" });
  });
});

describe("decisionMessage", () => {
  it("says what each write-gate decision did", () => {
    expect(decisionMessage("approved")).toContain("released");
    expect(decisionMessage("rejected")).toContain("stays hidden");
    expect(decisionMessage("stale")).toContain("changed");
    expect(decisionMessage("already_decided")).toContain("already");
    expect(decisionMessage("not_found")).toContain("no longer");
  });
});

describe("safeAuthorizeUrl", () => {
  it("follows only an https provider address with no credentials in it", () => {
    expect(safeAuthorizeUrl("https://accounts.example.test/o/oauth2/auth?client_id=x")).toBe("https://accounts.example.test/o/oauth2/auth?client_id=x");
    expect(safeAuthorizeUrl("http://accounts.example.test/auth")).toBeNull();
    expect(safeAuthorizeUrl("javascript:alert(1)")).toBeNull();
    expect(safeAuthorizeUrl("https://user:pw@accounts.example.test/auth")).toBeNull();
    expect(safeAuthorizeUrl("/admin/")).toBeNull();
  });
});

describe("providerLabel", () => {
  it("names the shipped providers and keeps an unknown id as it is", () => {
    expect(providerLabel("google")).toBe("Google");
    expect(providerLabel("fireflies")).toBe("Fireflies");
    expect(providerLabel("acme_mail")).toBe("acme_mail");
  });
});

describe("deleteOutcome", () => {
  it("says what was deleted, and that pages changed after the preview were kept and need another look", () => {
    expect(deleteOutcome({ deleted: 3, changed: 0 }, "owner@example.test")).toEqual({ done: true, message: "Deleted 3 pages from owner@example.test." });
    const partial = deleteOutcome({ deleted: 2, changed: 1 }, "owner@example.test");
    expect(partial.done).toBe(false);
    expect(partial.message).toBe("Deleted 2 pages from owner@example.test. 1 page changed after the preview and was kept: preview again to review it.");
  });
});
