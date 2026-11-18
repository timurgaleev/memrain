/**
 * The /app wizard: connect → fill → ask (core/onboarding.ts, http/app-onboarding.ts).
 *
 * A step closes only when the thing really happened, read from the rows that
 * prove it: a call made with one of the member's own credentials, the first
 * page in the member's personal source, the first answer that came back `ok`.
 * Markers are kept once set, so the wizard only moves forward and survives a
 * restart. Another member's activity never moves this member's wizard.
 *
 * Filling: pasted text becomes a page in the personal source at tier member;
 * a ChatGPT or Claude export is imported there, refused with a plain message
 * when it is not one, and held for confirmation when its embedding estimate
 * passes MEMRAIN_ONBOARD_IMPORT_MAX_USD.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, type MemberActor } from "../src/core/members.ts";
import { APP_COOKIE, createMemberSession } from "../src/core/member-sessions.ts";
import { createChatThread } from "../src/core/chat/store.ts";
import { mintMemberInvite, openMemberInvite } from "../src/core/member-invites.ts";
import { refreshOnboarding, importEstimateUsd } from "../src/core/onboarding.ts";
import { handleApp } from "../src/http/app.ts";
import { setTenantPolicySource } from "../src/control/contract.ts";

setDefaultTimeout(60_000);

const ORIGIN = "https://acme.example.test";
const OPS: MemberActor = { actor: "ops", via: "cli" };
const ENV_KEYS = ["MEMRAIN_APP", "MEMRAIN_KEYWORD_ONLY", "MEMRAIN_ONBOARD_IMPORT_MAX_USD", "MEMRAIN_TENANT_ID", "MEMRAIN_CONTROL_URL"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

let tmp: string;
let storage: Storage;
const cookies = new Map<string, string>();

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-app-onboarding-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  const e = storage.engine();
  for (const id of ["alice", "bob", "carol", "erin", "fay"]) {
    await registerSource(e, { id: `person-${id}`, kind: "other", pathPrefix: `/person-${id}` });
    await addMember(e, id, { personalSource: `person-${id}` }, OPS);
    cookies.set(id, (await createMemberSession(e, id, "passkey")).id);
  }
});
afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["MEMRAIN_APP"] = "1";
  process.env["MEMRAIN_KEYWORD_ONLY"] = "1";
  delete process.env["MEMRAIN_ONBOARD_IMPORT_MAX_USD"];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function call(member: string | null, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (member) headers.cookie = `${APP_COOKIE}=${cookies.get(member)}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
  const res = await handleApp(req, new URL(req.url), { storage, publicUrl: ORIGIN });
  if (!res) throw new Error(`not handled: ${path}`);
  return res;
}

const state = (id: string) => refreshOnboarding(storage.engine(), { memberId: id, personalSourceId: `person-${id}` });

async function answer(owner: string, status: string, at: string): Promise<void> {
  const thread = await createChatThread(storage.engine(), {
    key: `member:${owner}`, sourceId: `person-${owner}`, readSources: [`person-${owner}`], spendId: `memrain_chat_m_${owner}`, fenceDiary: true,
  }, "a question");
  await storage.engine().query(
    `INSERT INTO chat_messages (thread_id, role, content, status, created_at) VALUES ($1, 'assistant', 'an answer', $2, $3::timestamptz)`,
    [thread, status, at],
  );
}

describe("wizard state", () => {
  it("starts at connect with nothing done", async () => {
    expect(await state("alice")).toMatchObject({ step: "connect", connected_at: null, first_write_at: null, first_answer_at: null });
  });

  it("closes connect on a successful call made with the member's own key, and only its own", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ('m-bob-key', 'hash-bob', ARRAY['read'], 'bob')`);
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ('m-alice-key', 'hash-alice', ARRAY['read'], 'alice')`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES ('m-bob-key', 'm-bob-key', 'search', 'success', '2026-11-18T10:00:00Z')`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES ('m-alice-key', 'm-alice-key', 'search', 'error', '2026-11-18T10:00:00Z')`);
    expect((await state("alice")).connected_at).toBeNull();
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status, created_at) VALUES ('m-alice-key', 'm-alice-key', 'search', 'success', '2026-11-18T10:01:00Z')`);
    const s = await state("alice");
    expect(s.connected_at).toBe("2026-11-18T10:01:00.000Z");
    expect(s.step).toBe("fill");
    expect((await state("bob")).connected_at).toBe("2026-11-18T10:00:00.000Z");
  });

  it("closes fill on the first page in the personal source, not in another", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id, created_at) VALUES ('notes/x', 'note', 'x', 'x', 'h-x', 'person-bob', '2026-11-18T10:02:00Z')`);
    expect((await state("alice")).first_write_at).toBeNull();
    await e.query(`INSERT INTO pages (slug, type, title, markdown_body, content_hash, source_id, created_at) VALUES ('notes/y', 'note', 'y', 'y', 'h-y', 'person-alice', '2026-11-18T10:03:00Z')`);
    expect(await state("alice")).toMatchObject({ step: "ask", first_write_at: "2026-11-18T10:03:00.000Z" });
  });

  it("closes ask only on an answer that came back ok", async () => {
    await answer("alice", "refused", "2026-11-18T10:04:00Z");
    expect((await state("alice")).first_answer_at).toBeNull();
    await answer("bob", "ok", "2026-11-18T10:04:30Z");
    expect((await state("alice")).first_answer_at).toBeNull();
    await answer("alice", "ok", "2026-11-18T10:05:00Z");
    expect(await state("alice")).toMatchObject({ step: "done", first_answer_at: "2026-11-18T10:05:00.000Z" });
  });

  it("only moves forward: erased evidence does not undo a step", async () => {
    const e = storage.engine();
    await e.query(`DELETE FROM chat_threads WHERE owner_key = 'member:alice'`);
    await e.query(`DELETE FROM pages WHERE source_id = 'person-alice'`);
    await e.query(`UPDATE access_tokens SET revoked_at = now() WHERE member_id = 'alice'`);
    await e.query(`DELETE FROM mcp_request_log WHERE token_name = 'm-alice-key'`);
    expect(await state("alice")).toMatchObject({
      step: "done", connected_at: "2026-11-18T10:01:00.000Z", first_write_at: "2026-11-18T10:03:00.000Z", first_answer_at: "2026-11-18T10:05:00.000Z",
    });
  });

  it("counts a sign-in through the member's own connector code as connected", async () => {
    const e = storage.engine();
    await e.query(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ('conn', 'connector', ARRAY['https://claude.ai/cb'])`);
    await e.query(
      `INSERT INTO oauth_enrollments (id, client_id, code_hash, source_id, federated_read, expires_at, member_id) VALUES ('enr-carol', 'conn', 'h', 'person-carol', ARRAY['person-carol'], now() + interval '1 day', 'carol')`,
    );
    await e.query(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, grant_bound, grant_id, created_at) VALUES ('t1', 'access', 'conn', true, 'enr-carol', '2026-11-18T11:00:00Z')`,
    );
    expect((await state("carol")).connected_at).toBe("2026-11-18T11:00:00.000Z");
    expect((await state("erin")).connected_at).toBeNull();
  });

  it("does not count a call made with another credential of the same name", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "person-gil", kind: "other", pathPrefix: "/person-gil" });
    await addMember(e, "gil", { personalSource: "person-gil" }, OPS);
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ('laptop', 'hash-gil', ARRAY['read'], 'gil')`);
    await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('laptop', 'hash-ops', ARRAY['read'])`);
    await e.query(`INSERT INTO mcp_request_log (token_name, agent_name, operation, status) VALUES ('laptop', 'laptop', 'search', 'success')`);
    expect((await refreshOnboarding(e, { memberId: "gil", personalSourceId: "person-gil" })).connected_at).toBeNull();
  });

  it("never stores an earlier step over a later one", async () => {
    const e = storage.engine();
    await registerSource(e, { id: "person-hal", kind: "other", pathPrefix: "/person-hal" });
    await addMember(e, "hal", { personalSource: "person-hal" }, OPS);
    await e.query(`INSERT INTO onboarding_state (member_id, step) VALUES ('hal', 'ask')`);
    await refreshOnboarding(e, { memberId: "hal", personalSourceId: "person-hal" });
    expect((await e.query<{ step: string }>(`SELECT step FROM onboarding_state WHERE member_id = 'hal'`)).rows[0]!.step).toBe("ask");
  });

  it("reports when the member first opened its invite", async () => {
    const invite = await mintMemberInvite(storage.engine(), "fay", 3600_000);
    await openMemberInvite(storage.engine(), invite.token, "f".repeat(64), Date.parse("2026-11-18T09:00:00Z"));
    expect((await state("fay")).opened_at).toBe("2026-11-18T09:00:00.000Z");
  });
});

describe("routes", () => {
  it("need a session", async () => {
    expect((await call(null, "GET", "/app/api/onboarding")).status).toBe(401);
    expect((await call(null, "POST", "/app/api/onboarding/paste", { text: "x" })).status).toBe(401);
  });

  it("GET reports the member's own wizard", async () => {
    const res = await call("alice", "GET", "/app/api/onboarding");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ step: "done", first_answer_at: "2026-11-18T10:05:00.000Z" });
    expect(await (await call("erin", "GET", "/app/api/onboarding")).json()).toMatchObject({ step: "connect" });
  });

  it("pasted text becomes a page in the personal source at tier member", async () => {
    const res = await call("erin", "POST", "/app/api/onboarding/paste", { title: "Garden plan", text: "Tomatoes go in the north bed." });
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    const row = await storage.engine().query<{ source_id: string; trust_tier: string | null; markdown_body: string }>(
      `SELECT source_id, trust_tier, markdown_body FROM pages WHERE slug = $1`, [slug],
    );
    expect(row.rows[0]).toMatchObject({ source_id: "person-erin", trust_tier: "member" });
    expect(row.rows[0]!.markdown_body).toContain("north bed");
    expect((await state("erin")).first_write_at).not.toBeNull();
  });

  it("refuses empty pasted text", async () => {
    const res = await call("erin", "POST", "/app/api/onboarding/paste", { text: "   " });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_params" });
  });

  it("refuses a file that is not a ChatGPT or Claude export, in plain words", async () => {
    const res = await call("erin", "POST", "/app/api/onboarding/import", { hello: "world" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_params");
    expect(body.message).toMatch(/ChatGPT or Claude export/);
    expect((await call("erin", "POST", "/app/api/onboarding/import", "not json")).status).toBe(400);
  });

  it("imports a Claude export into the personal source at tier member", async () => {
    const res = await call("erin", "POST", "/app/api/onboarding/import", claudeExport("conv-1", "Where does the compost go?"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ format: "claude-ai", sessions: 1 });
    const rows = await storage.engine().query<{ source_id: string; trust_tier: string | null }>(
      `SELECT source_id, trust_tier FROM pages WHERE markdown_body LIKE '%compost%'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r).toEqual({ source_id: "person-erin", trust_tier: "member" });
  });

  it("holds an import whose estimate passes the cap until it is confirmed", async () => {
    process.env["MEMRAIN_ONBOARD_IMPORT_MAX_USD"] = "0.0000001";
    const file = claudeExport("conv-2", "How deep do the carrots go?");
    const held = await call("erin", "POST", "/app/api/onboarding/import", file);
    expect(held.status).toBe(409);
    const body = (await held.json()) as { error: string; estimate_usd: number; cap_usd: number };
    expect(body.error).toBe("import_over_cap");
    expect(body.estimate_usd).toBeGreaterThan(body.cap_usd);
    const none = await storage.engine().query(`SELECT 1 FROM pages WHERE markdown_body LIKE '%carrots%'`);
    expect(none.rows.length).toBe(0);
    expect((await call("erin", "POST", "/app/api/onboarding/import?confirm=1", file)).status).toBe(200);
  });

  it("on a hosted brain at its plan's page limit, refuses an import and writes nothing", async () => {
    process.env["MEMRAIN_TENANT_ID"] = "acme";
    process.env["MEMRAIN_CONTROL_URL"] = "set-by-the-test-source";
    setTenantPolicySource(async () => ({ status: "active", mode: null, limits: { maxPages: 1 }, llmOff: false, isolation: "verified" }));
    try {
      const res = await call("erin", "POST", "/app/api/onboarding/import", claudeExport("conv-3", "When do the beans flower?"));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("tenant_limit_reached");
      const none = await storage.engine().query(`SELECT 1 FROM pages WHERE markdown_body LIKE '%beans flower%'`);
      expect(none.rows.length).toBe(0);
    } finally {
      setTenantPolicySource(null);
    }
  });

  it("estimates an import from its text, and a bigger one costs more", () => {
    expect(importEstimateUsd(0)).toBe(0);
    expect(importEstimateUsd(4_000_000)).toBeGreaterThan(importEstimateUsd(1_000));
  });
});

function claudeExport(uuid: string, question: string): unknown[] {
  return [{
    uuid,
    name: "Garden",
    created_at: "2026-11-01T10:00:00Z",
    chat_messages: [
      { uuid: `${uuid}-1`, sender: "human", text: question, created_at: "2026-11-01T10:00:00Z" },
      { uuid: `${uuid}-2`, sender: "assistant", text: "Behind the shed, away from the beds.", created_at: "2026-11-01T10:00:05Z" },
    ],
  }];
}
