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
  confirmMatches,
  connectOutcome,
  connectorErrorCopy,
  daemonView,
  decisionMessage,
  providerLabel,
  safeAuthorizeUrl,
  sourcesFor,
  type ConnectorAccountView,
  type DaemonView,
} from "../admin/src/lib/automation.ts";

const base: ConnectorAccountView = {
  id: "a1", source_id: "inbox", provider: "google", services: ["calendar"], account_label: "owner@example.test",
  status: "active", status_reason: null, enabled: false, spend_cap_usd_daily: 1, item_cap_daily: 5000,
  last_success_at: null, held_items: 0, held_deletes: 0, notices: [], credential: { scopes: ["calendar.readonly"], expires_at: null },
};

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

describe("connectOutcome", () => {
  it("reads the outcome a finished connect left in the query", () => {
    expect(connectOutcome("?connector=connected")).toEqual({ ok: true, message: "Account connected. Sync stays off until you switch it on." });
    expect(connectOutcome("?connector_error=state_expired")).toEqual({ ok: false, message: "The connect link expired. Start again." });
    expect(connectOutcome("?connector_error=scope_mismatch")?.message).toContain("different access");
    expect(connectOutcome("")).toBeNull();
    expect(connectOutcome("?other=1")).toBeNull();
  });

  it("explains why a pasted API key was not saved", () => {
    expect(connectorErrorCopy("key_rejected")).toContain("refused the key");
    expect(connectorErrorCopy("key_invalid")).toContain("does not look like an API key");
    expect(connectorErrorCopy("provider_unavailable")).toContain("could not be reached");
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
