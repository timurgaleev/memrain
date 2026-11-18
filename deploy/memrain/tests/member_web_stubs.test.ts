/**
 * The member web-auth entry points other lanes call before they exist for
 * real: no request resolves to a member session yet, and minting an invite
 * refuses as not implemented without touching the database.
 */
import { describe, expect, it } from "bun:test";
import type { Engine } from "../src/core/engine/interface.ts";
import { resolveMemberSession } from "../src/core/member-sessions.ts";
import { MemberInviteError, memberInviteUrl, mintMemberInvite } from "../src/core/member-invites.ts";

const untouchable = new Proxy({}, {
  get(_t, prop) { throw new Error(`engine.${String(prop)} must not be touched`); },
}) as Engine;

describe("resolveMemberSession", () => {
  it("resolves no session, even with a member cookie, and reads nothing", async () => {
    const req = new Request("http://h/app/api/chat", { headers: { Cookie: "memrain_app=abc" } });
    expect(await resolveMemberSession(untouchable, req)).toBeNull();
  });
});

describe("mintMemberInvite", () => {
  it("refuses with not_implemented and reads nothing", async () => {
    let err: unknown;
    try {
      await mintMemberInvite(untouchable, "alice", 72 * 3600_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemberInviteError);
    expect((err as MemberInviteError).code).toBe("not_implemented");
  });
});

describe("memberInviteUrl", () => {
  it("carries the token in the fragment, never the query", () => {
    expect(memberInviteUrl("https://acme.example.test/", "tok_123")).toBe("https://acme.example.test/app/invite#tok_123");
    expect(memberInviteUrl("https://acme.example.test", "tok_123")).toBe("https://acme.example.test/app/invite#tok_123");
  });
});
