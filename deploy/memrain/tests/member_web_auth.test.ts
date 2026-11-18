/**
 * Member web sign-in storage: one-time invites, member passkeys and the
 * `memrain_app` session (core/member-invites.ts, member-passkeys.ts,
 * member-sessions.ts).
 *
 * Only hashes are stored. An invite is reserved for the browser that opened
 * it and consumed exactly once. A session dies with its member: disabling or
 * removing the member ends it on the next request, and so do 7 idle days or
 * 30 days in all.
 */
import { describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { addMember, disableMember, removeMember, type MemberActor } from "../src/core/members.ts";
import { registerSource } from "../src/core/sources.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import {
  MemberInviteError,
  mintMemberInvite,
  openMemberInvite,
  redeemInviteWithoutPasskey,
} from "../src/core/member-invites.ts";
import {
  APP_COOKIE,
  INVITE_SESSION_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_TTL_MS,
  createMemberSession,
  memberSessionCookie,
  resolveMemberSession,
  revokeMemberSessions,
} from "../src/core/member-sessions.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };
const HOUR = 3600_000;
const DAY = 24 * HOUR;

async function seed(e: Engine, id = "alice", withSource = true): Promise<void> {
  if (withSource) await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
  await addMember(e, id, withSource ? { personalSource: `person-${id}` } : {}, OPS);
}

async function inviteCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof MemberInviteError) return e.code;
    throw e;
  }
  return "no error";
}

function appReq(cookie: string | null, path = "/app/api/me"): Request {
  return new Request(`https://acme.example.test${path}`, cookie ? { headers: { Cookie: `${APP_COOKIE}=${cookie}` } } : {});
}

for (const { name, open } of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`member web auth (${name})`, () => {
  it("mints an invite only for an enabled member with a personal source", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e, "alice");
      await seed(e, "bob", false);
      expect(await inviteCode(mintMemberInvite(e, "bob", 72 * HOUR))).toBe("member_not_ready");
      expect(await inviteCode(mintMemberInvite(e, "nobody", 72 * HOUR))).toBe("not_found");
      expect(await inviteCode(mintMemberInvite(e, "alice", 0))).toBe("invalid_ttl");
      await disableMember(e, "alice", OPS);
      expect(await inviteCode(mintMemberInvite(e, "alice", 72 * HOUR))).toBe("member_not_enabled");
    } finally {
      await db.close();
    }
  });

  it("stores only the token's hash and revokes an earlier unused invite", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const first = await mintMemberInvite(e, "alice", 72 * HOUR);
      const dump = JSON.stringify((await e.query(`SELECT * FROM member_invites`)).rows);
      expect(dump).not.toContain(first.token);
      const second = await mintMemberInvite(e, "alice", 72 * HOUR);
      expect(await openMemberInvite(e, first.token, "pre-a")).toEqual({ ok: false, reason: "revoked" });
      const opened = await openMemberInvite(e, second.token, "pre-a");
      expect(opened).toMatchObject({ ok: true, memberId: "alice" });
    } finally {
      await db.close();
    }
  });

  it("reserves an opened invite for one browser and consumes it once", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const now = Date.parse("2026-11-18T10:00:00Z");
      const inv = await mintMemberInvite(e, "alice", 72 * HOUR, { nowMs: now });
      expect(await openMemberInvite(e, inv.token, "pre-a", now + 1000)).toMatchObject({ ok: true });
      // The same browser may reopen; another one may not while the lease runs.
      expect(await openMemberInvite(e, inv.token, "pre-a", now + 2000)).toMatchObject({ ok: true });
      expect(await openMemberInvite(e, inv.token, "pre-b", now + 3000)).toEqual({ ok: false, reason: "reserved" });
      expect(await openMemberInvite(e, "not-a-token", "pre-a", now)).toEqual({ ok: false, reason: "unknown" });

      expect(await redeemInviteWithoutPasskey(e, inv.token, "pre-b", now + 4000)).toEqual({ ok: false, reason: "reserved" });
      const redeemed = await redeemInviteWithoutPasskey(e, inv.token, "pre-a", now + 4000);
      expect(redeemed.ok).toBe(true);
      if (!redeemed.ok) throw new Error("unreachable");
      expect(redeemed.session.expiresAt - (now + 4000)).toBe(INVITE_SESSION_TTL_MS);
      expect(await redeemInviteWithoutPasskey(e, inv.token, "pre-a", now + 5000)).toEqual({ ok: false, reason: "used" });
      expect(await openMemberInvite(e, inv.token, "pre-a", now + 5000)).toEqual({ ok: false, reason: "used" });
      const opened = await e.query<{ opened_at: unknown }>(`SELECT opened_at FROM member_invites WHERE id = $1`, [inv.inviteId]);
      expect(new Date(String(opened.rows[0]!.opened_at instanceof Date ? (opened.rows[0]!.opened_at as Date).toISOString() : opened.rows[0]!.opened_at)).getTime()).toBe(now + 1000);
    } finally {
      await db.close();
    }
  });

  it("refuses an expired invite", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const now = Date.parse("2026-11-18T10:00:00Z");
      const inv = await mintMemberInvite(e, "alice", HOUR, { nowMs: now });
      expect(await openMemberInvite(e, inv.token, "pre-a", now + HOUR + 1)).toEqual({ ok: false, reason: "expired" });
    } finally {
      await db.close();
    }
  });

  it("resolves a session cookie to the member and the sources it reads", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const now = Date.now();
      const s = await createMemberSession(e, "alice", "passkey", now);
      expect(s.expiresAt - now).toBe(SESSION_TTL_MS);
      const dump = JSON.stringify((await e.query(`SELECT * FROM member_web_sessions`)).rows);
      expect(dump).not.toContain(s.id);
      const got = await resolveMemberSession(e, appReq(s.id), now + 1000);
      expect(got).toMatchObject({ memberId: "alice", personalSourceId: "person-alice", readSet: ["person-alice"] });
      expect(got?.access.refused).toBeNull();
      expect(await resolveMemberSession(e, appReq("forged"), now)).toBeNull();
      expect(await resolveMemberSession(e, appReq(null), now)).toBeNull();
      // The cookie is scoped to /app; any other path never resolves it.
      expect(await resolveMemberSession(e, appReq(s.id, "/admin/api/chat/threads"), now)).toBeNull();
      expect(await resolveMemberSession(e, appReq(s.id, "/s/abc"), now)).toBeNull();
      expect(await resolveMemberSession(e, appReq(s.id, "/application"), now)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("ends the session when the member is disabled or removed", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e, "alice");
      await seed(e, "bob");
      const now = Date.now();
      const a = await createMemberSession(e, "alice", "passkey", now);
      const b = await createMemberSession(e, "bob", "passkey", now);
      await disableMember(e, "alice", OPS);
      expect(await resolveMemberSession(e, appReq(a.id), now)).toBeNull();
      await removeMember(e, "bob", OPS);
      expect(await resolveMemberSession(e, appReq(b.id), now)).toBeNull();
      const live = await e.query(`SELECT 1 FROM member_web_sessions WHERE revoked_at IS NULL`);
      expect(live.rows.length).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("expires after 7 idle days or 30 days in all, and on revoke", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      const t0 = Date.parse("2026-11-01T00:00:00Z");
      const idle = await createMemberSession(e, "alice", "passkey", t0);
      expect(await resolveMemberSession(e, appReq(idle.id), t0 + SESSION_IDLE_MS + 1)).toBeNull();

      const busy = await createMemberSession(e, "alice", "passkey", t0);
      for (let t = t0 + DAY; t < t0 + SESSION_TTL_MS; t += 5 * DAY) {
        expect(await resolveMemberSession(e, appReq(busy.id), t)).not.toBeNull();
      }
      expect(await resolveMemberSession(e, appReq(busy.id), t0 + SESSION_TTL_MS + 1)).toBeNull();

      const later = await createMemberSession(e, "alice", "passkey", t0);
      expect(await revokeMemberSessions(e, "alice", t0)).toBeGreaterThan(0);
      expect(await resolveMemberSession(e, appReq(later.id), t0 + 1)).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("reads the personal source and the member's group sources, nothing else", async () => {
    const db = await open();
    const e = db.storage.engine();
    try {
      await seed(e);
      await registerSource(e, { id: "team-docs", kind: "other", pathPrefix: "/team-docs" });
      await e.query(`INSERT INTO groups (id) VALUES ('team')`);
      await e.query(`INSERT INTO group_sources (group_id, source_id) VALUES ('team', 'team-docs')`);
      await e.query(`INSERT INTO group_members (group_id, member_id) VALUES ('team', 'alice')`);
      const s = await createMemberSession(e, "alice", "passkey");
      const got = await resolveMemberSession(e, appReq(s.id));
      expect(got?.readSet).toEqual(["person-alice", "team-docs"]);
    } finally {
      await db.close();
    }
  });
});

describe("memrain_app cookie", () => {
  it("is always Path=/app, HttpOnly, Secure and SameSite=Strict", () => {
    for (const c of [memberSessionCookie("abc", 1000), memberSessionCookie(null)]) {
      expect(c.startsWith(`${APP_COOKIE}=`)).toBe(true);
      expect(c).toContain("; Path=/app;");
      expect(c).toContain("; HttpOnly");
      expect(c).toContain("; Secure");
      expect(c).toContain("; SameSite=Strict");
      expect(c).not.toContain("Domain=");
    }
    expect(memberSessionCookie(null)).toContain("Max-Age=0");
  });
});
