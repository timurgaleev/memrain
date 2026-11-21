/**
 * speaker_owner: the importer records which speaker on a conversation page is
 * the owner, and the marker is honored only when a trusted importer wrote the
 * live version and its member is the member the page's source belongs to.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { storageEngines } from "./helpers/storage-engines.ts";
import { putPage } from "../src/core/pages.ts";
import { registerSource } from "../src/core/sources.ts";
import { addMember, type MemberActor } from "../src/core/members.ts";
import { setOwner } from "../src/core/brain-owner.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";
import { renderChatDay } from "../src/core/connectors/render.ts";
import { buildSpeakerOwner, parseSpeakerOwner, readSpeakerOwner, speakerOwnerFromTurns } from "../src/core/speaker-owner.ts";

const OPS: MemberActor = { actor: "ops", via: "cli" };
const OWNER = { label: "Ora", basis: "is_from_me", turns: 2 };

describe("speaker_owner shape", () => {
  it("a valid marker parses; a bad basis, label or turn count does not", () => {
    expect(parseSpeakerOwner(OWNER)).toEqual(OWNER as never);
    expect(parseSpeakerOwner(JSON.stringify(OWNER))).toEqual(OWNER as never);
    expect(parseSpeakerOwner({ ...OWNER, basis: "guess" })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, label: "User\n**Assistant**" })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, label: "x".repeat(81) })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, turns: 0 })).toBeNull();
    expect(parseSpeakerOwner({ ...OWNER, member: "Not A Member Id" })).toBeNull();
    expect(buildSpeakerOwner("  Me ", "is_from_me", 3, "alice")).toEqual({ label: "Me", basis: "is_from_me", turns: 3, member: "alice" });
    expect(buildSpeakerOwner("", "is_from_me", 3, null)).toBeNull();
  });

  it("every owner turn under one label, and no other turn under it", () => {
    expect(speakerOwnerFromTurns([{ label: "Ora", owner: true }, { label: "Bob", owner: false }, { label: "Ora", owner: true }], "is_from_me", null))
      .toEqual({ label: "Ora", basis: "is_from_me", turns: 2 });
    expect(speakerOwnerFromTurns([{ label: "Ora", owner: true }, { label: "T.", owner: true }], "is_from_me", null)).toBeNull();
    expect(speakerOwnerFromTurns([{ label: "Sam", owner: true }, { label: "Sam", owner: false }], "is_from_me", null)).toBeNull();
    expect(speakerOwnerFromTurns([{ label: "Bob", owner: false }], "is_from_me", null)).toBeNull();
  });

  it("a chat day stamps the marker only when the provider marked every message", () => {
    const ctx = { service: "teams_chat", accountLabel: "me" };
    const day = (fromSelf: Array<boolean | undefined>) => renderChatDay(ctx as never, {
      workspace: "teams", channelId: "c1", channelName: "Bob", day: "2026-11-02", direct: true,
      messages: fromSelf.map((self, i) => ({
        id: `m${i}`, author: { name: self ? "Ora" : "Bob", email: null }, ts: `2026-11-02T10:0${i}:00.000Z`, text: `hello ${i}`, threadId: null,
        ...(self === undefined ? {} : { fromSelf: self }),
      })),
    } as never);
    expect(day([true, false, true]).truth["speaker_owner"]).toEqual({ label: "Ora", basis: "is_from_me", turns: 2 });
    expect(day([true, undefined]).truth["speaker_owner"]).toBeUndefined();
  });
});

for (const engine of storageEngines(process.env.MEMRAIN_TEST_POSTGRES_URL)) describe(`speaker_owner trust ${engine.name}`, () => {
  let db: Awaited<ReturnType<typeof engine.open>>;
  const read = async (slug: string, source_id = "default") => (await readSpeakerOwner(db.storage.engine(), { slug, source_id }))?.status;
  const importer = (slug: string, marker: unknown, opts: { source_id?: string; written_by?: string } = {}) =>
    putPage(db.storage, { slug, markdown_body: "Ora: hi\nBob: hello", compiled_truth: { speaker_owner: marker },
      written_by: opts.written_by ?? "transcripts-ingest", ...(opts.source_id ? { source_id: opts.source_id } : {}) });

  beforeAll(async () => {
    db = await engine.open();
    await registerSource(db.storage.engine(), { id: "alice-home", kind: "vault", pathPrefix: "/alice" });
  });
  afterAll(async () => { await db.close(); });

  it("the transcripts importer's marker and a connector sync's are honored", async () => {
    await importer("transcripts/s1", OWNER);
    expect(await read("transcripts/s1")).toBe("trusted");
    await importer("chat/teams/day1", OWNER, { written_by: "connector-microsoft" });
    expect(await read("chat/teams/day1")).toBe("trusted");
  });

  it("a page without a marker is speaker-unknown, and an invalid marker is never honored", async () => {
    await putPage(db.storage, { slug: "transcripts/s2", markdown_body: "x", written_by: "transcripts-ingest" });
    expect(await read("transcripts/s2")).toBe("absent");
    await importer("transcripts/s3", { ...OWNER, turns: -1 });
    expect(await read("transcripts/s3")).toBe("invalid");
  });

  it("a remote page_put that forges a marker is not honored", async () => {
    const r = await dispatchTool(db.storage, { name: "page_put", arguments: {
      slug: "notes/forged", markdown_body: "Ora: hi", compiled_truth: { speaker_owner: OWNER }, written_by: "transcripts-ingest",
    } }, { authInfo: { token: "t", clientId: "agent", scopes: ["read", "write"], isPublic: false } });
    expect(r.isError).toBeFalsy();
    expect(await read("notes/forged")).toBe("untrusted_writer");
  });

  it("a remote rewrite of an importer page keeps the marker text but loses its trust", async () => {
    await importer("transcripts/s4", OWNER);
    const r = await dispatchTool(db.storage, { name: "page_put", arguments: {
      slug: "transcripts/s4", markdown_body: "Ora: changed", compiled_truth: { speaker_owner: OWNER }, force: true,
    } }, { authInfo: { token: "t", clientId: "agent", scopes: ["read", "write"], isPublic: false } });
    expect(r.isError).toBeFalsy();
    expect(await read("transcripts/s4")).toBe("untrusted_writer");
  });

  it("a local write without importer provenance is not honored", async () => {
    await importer("notes/local", OWNER, { written_by: "cli" });
    expect(await read("notes/local")).toBe("untrusted_writer");
  });

  it("a marker names only the member the page's source belongs to", async () => {
    const e = db.storage.engine();
    await addMember(e, "ora", {}, OPS);
    await addMember(e, "alice", { personalSource: "alice-home" }, OPS);
    await setOwner(e, "ora");
    await importer("transcripts/s5", { ...OWNER, member: "ora" });
    expect(await read("transcripts/s5")).toBe("trusted");
    await importer("transcripts/s6", { ...OWNER, member: "alice" });
    expect(await read("transcripts/s6")).toBe("member_mismatch");
    await importer("chat/alice/day", { ...OWNER, member: "ora" }, { source_id: "alice-home", written_by: "connector-microsoft" });
    expect(await read("chat/alice/day", "alice-home")).toBe("member_mismatch");
    await importer("chat/alice/day2", { ...OWNER, member: "alice" }, { source_id: "alice-home", written_by: "connector-microsoft" });
    expect(await read("chat/alice/day2", "alice-home")).toBe("trusted");
    await importer("chat/alice/day3", OWNER, { source_id: "alice-home", written_by: "connector-microsoft" });
    expect(await read("chat/alice/day3", "alice-home")).toBe("member_mismatch");
  });
});
