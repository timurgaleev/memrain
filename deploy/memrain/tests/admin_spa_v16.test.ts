/**
 * The admin SPA's passkey helpers (admin/src/lib/passkey*.ts, route.ts): the
 * enroll and security routes, the setup-token parse, recovery-code handling,
 * error copy for every code the passkey endpoints return to the panel, and a
 * pre-auth fetch that never bounces to #login. Pure modules, no DOM.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { buildHash, parseHash } from "../admin/src/lib/route.ts";
import {
  formatRecoveryCodes,
  isPreAuthRoute,
  listOf,
  normalizeRecoveryInput,
  parseEnrollToken,
  passkeyErrorCopy,
} from "../admin/src/lib/passkey.ts";
import { passkeyFetch } from "../admin/src/lib/passkey-fetch.ts";
import { normalizeRecoveryCode } from "../src/core/admin-passkey-store.ts";

const TOKEN = "Abc_def-0123456789abcdefghijklmnopqrstuvwxy";

describe("routes", () => {
  it("parses #enroll/<token> and #security", () => {
    expect(TOKEN).toHaveLength(43);
    expect(parseHash(`#enroll/${TOKEN}`)).toEqual({ name: "enroll", param: TOKEN });
    expect(parseHash("#enroll")).toEqual({ name: "enroll", param: null });
    expect(parseHash("#security")).toEqual({ name: "security", param: null });
    expect(buildHash({ name: "security", param: null })).toBe("#security");
  });

  it("treats login and enroll, and nothing else, as pre-auth", () => {
    expect(isPreAuthRoute("login")).toBe(true);
    expect(isPreAuthRoute("enroll")).toBe(true);
    for (const n of ["overview", "security", "setup", "search"] as const) expect(isPreAuthRoute(n)).toBe(false);
  });
});

describe("parseEnrollToken", () => {
  it("returns the token only for a well-formed #enroll/<token>", () => {
    expect(parseEnrollToken(`#enroll/${TOKEN}`)).toBe(TOKEN);
    expect(parseEnrollToken(`#/enroll/${TOKEN}`)).toBe(TOKEN);
    expect(parseEnrollToken("#enroll")).toBeNull();
    expect(parseEnrollToken("#enroll/")).toBeNull();
    expect(parseEnrollToken("#enroll/<script>")).toBeNull();
    expect(parseEnrollToken(`#login/${TOKEN}`)).toBeNull();
  });
});

describe("recovery codes", () => {
  const codes = Array.from({ length: 10 }, (_, i) => `ABCD-EFGH-JKMN-PQRS-TVWX-YZ${String(i).padStart(2, "0")}`);

  it("normalizes typed input to what the server accepts", () => {
    for (const typed of ["abcd efgh jkmn pqrs tvwx yz00", " ABCD-EFGH-JKMN-PQRS-TVWX-YZ00 "]) {
      const n = normalizeRecoveryInput(typed);
      expect(n).toBe("ABCDEFGHJKMNPQRSTVWXYZ00");
      expect(normalizeRecoveryCode(n)).toBe(n);
    }
  });

  it("the saved text holds all 10 codes and no host name", () => {
    const text = formatRecoveryCodes(codes);
    for (const c of codes) expect(text).toContain(c);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\b[a-z0-9-]+\.(?:com|net|org|example|localhost)\b/i);
  });
});

describe("passkeyErrorCopy", () => {
  // Codes the passkey endpoints return for situations a person can hit.
  const CODES = [
    "invalid_token", "invalid_code", "grant_lost", "passkey_failed", "passkey_unconfigured",
    "credential_exists", "slowed", "rate_limited", "reauth_required", "cooldown", "last_passkey",
  ];

  it("has specific copy for every typed error, and a fallback for the rest", () => {
    const fallback = passkeyErrorCopy("no_such_code");
    for (const c of CODES) {
      const copy = passkeyErrorCopy(c);
      expect({ c, specific: copy !== fallback && copy.length > 0 }).toEqual({ c, specific: true });
    }
    expect(passkeyErrorCopy(undefined)).toBe(fallback);
    expect(passkeyErrorCopy("__proto__")).toBe(fallback);
  });
});

describe("listOf", () => {
  it("reads the server's {events} and {notices} envelopes", () => {
    expect(listOf<number>({ events: [1, 2] }, "events")).toEqual([1, 2]);
    expect(listOf<number>({ notices: [3] }, "notices")).toEqual([3]);
    expect(listOf<number>({ other: 1 }, "events")).toEqual([]);
  });
});

describe("passkeyFetch", () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as unknown as { window?: unknown; location?: unknown };
  const hadWindow = "window" in g;
  const hadLocation = "location" in g;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (!hadWindow) delete g.window;
    if (!hadLocation) delete g.location;
  });

  it("returns a 401 as a typed result and leaves location.hash alone", async () => {
    const location = { hash: "#enroll" };
    g.location = location;
    g.window = { location };
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sent = init;
      return Response.json({ error: "passkey_failed" }, { status: 401 });
    }) as unknown as typeof fetch;
    const r = await passkeyFetch("/admin/api/passkey/login/verify", { method: "POST", body: "{}" });
    expect(r).toEqual({ status: 401, ok: false, body: { error: "passkey_failed" } });
    expect(location.hash).toBe("#enroll");
    expect(new Headers(sent!.headers).get("content-type")).toBe("application/json");
  });
});
