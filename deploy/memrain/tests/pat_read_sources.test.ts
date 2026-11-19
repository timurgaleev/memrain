/**
 * `auth permissions <name> set-read-sources a,b,c` changes a personal access
 * token's read set in place.
 *
 * The write source never moves and is always readable; every named source
 * must exist; a dry run shows the change and writes nothing; a real change is
 * revision-bumped and audited as `pat:<id>` like every other PAT grant change,
 * and the next verification reads the new set.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { OAuthProvider, type GrantActor } from "../src/core/oauth-provider.ts";
import { registerSource } from "../src/core/sources.ts";

const OPS: GrantActor = { actor: "ops", via: "cli" };
let tmp: string;
let storage: Storage;
let provider: OAuthProvider;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-pat-read-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of ["team", "calendar", "mail"]) {
    await registerSource(storage.engine(), { id, kind: "other", pathPrefix: `tenant:${id}` });
  }
  provider = new OAuthProvider({ engine: storage.raw() });
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

async function mint(name: string, permissions: Record<string, unknown>) {
  const token = "memrain_" + randomBytes(24).toString("hex");
  const r = await storage.raw().query<{ id: number }>(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions) VALUES ($1, $2, ARRAY['read','write'], $3::jsonb) RETURNING id`,
    [name, createHash("sha256").update(token).digest("hex"), permissions],
  );
  return { token, id: Number(r.rows[0]!.id) };
}

const auditRows = async (id: number) => (await storage.raw().query<{ after: Record<string, unknown> }>(
  `SELECT after FROM oauth_grant_audit WHERE client_id = $1 ORDER BY revision`, [`pat:${id}`])).rows;

describe("set-read-sources", () => {
  it("adds a source to an unscoped token's read set, keeping its write source", async () => {
    const pat = await mint("laptop", { takes_holders: ["world"] });
    expect((await provider.verifyAccessToken(pat.token)).allowedSources).toBeUndefined();

    const [change] = await provider.setPatReadSources("laptop", ["default", "calendar"], OPS);
    expect(change!.before.source_id).toBeNull();
    expect(change!.after.source_id).toEqual(["default", "calendar"]);
    const info = await provider.verifyAccessToken(pat.token);
    expect(info.sourceId).toBe("default");
    expect(info.allowedSources).toEqual(["default", "calendar"]);
    // The takes-holder knob next to it survives the merge.
    const perms = (await storage.raw().query<{ permissions: Record<string, unknown> }>(
      `SELECT permissions FROM access_tokens WHERE id = $1`, [pat.id])).rows[0]!.permissions;
    expect(perms.takes_holders).toEqual(["world"]);
    expect((await auditRows(pat.id)).at(-1)!.after).toMatchObject({ action: "set_read_sources", source_id: ["default", "calendar"] });
  });

  it("always keeps the write source first and readable", async () => {
    const pat = await mint("agent", { source_id: "team" });
    const [change] = await provider.setPatReadSources("agent", ["mail"], OPS);
    expect(change!.after.source_id).toEqual(["team", "mail"]);
    expect((await provider.verifyAccessToken(pat.token)).sourceId).toBe("team");
    // Back to the write source alone stores the scalar form.
    const [narrow] = await provider.setPatReadSources("agent", ["team"], OPS);
    expect(narrow!.after.source_id).toBe("team");
    expect((await provider.verifyAccessToken(pat.token)).allowedSources).toEqual(["team"]);
  });

  it("a dry run reports the change and writes nothing", async () => {
    const pat = await mint("preview", { source_id: "team" });
    const [change] = await provider.setPatReadSources("preview", ["calendar"], OPS, { dryRun: true });
    expect(change!.after.source_id).toEqual(["team", "calendar"]);
    expect((await provider.verifyAccessToken(pat.token)).allowedSources).toEqual(["team"]);
    expect(await auditRows(pat.id)).toEqual([]);
  });

  it("refuses an unknown source, an empty list and an unknown token", async () => {
    await mint("strict", { source_id: "team" });
    await expect(provider.setPatReadSources("strict", ["team", "nope"], OPS)).rejects.toThrow("Unknown source 'nope'");
    await expect(provider.setPatReadSources("strict", [" "], OPS)).rejects.toThrow("cannot be empty");
    expect(await provider.setPatReadSources("no-such-token", ["team"], OPS)).toEqual([]);
  });
});
