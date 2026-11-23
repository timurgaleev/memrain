/**
 * The verifier on a schema stopped between migrations 162 and 164.
 *
 * Member bindings exist (162) but the tool_surface column does not (164).
 * The verifier retries its read without the missing column only; it must not
 * drop member_id with it, or a disabled member's key would verify again.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { discoverMigrations, revertMigration } from "../src/core/migrate.ts";
import { InvalidTokenError, OAuthProvider } from "../src/core/oauth-provider.ts";

let tmp: string;
let storage: Storage;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-member-schema-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  for (const id of discoverMigrations().map((m) => m.id).filter((m) => m >= 164).sort((a, b) => b - a)) {
    await revertMigration(storage.engine(), id);
  }
}, 30_000);

afterAll(async () => {
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
}, 30_000);

it("still refuses a disabled member's token when only tool_surface is missing", async () => {
  const e = storage.engine();
  const token = "memrain_" + randomBytes(24).toString("hex");
  await e.query(`INSERT INTO access_tokens (name, token_hash, scopes) VALUES ('k', $1, ARRAY['read'])`, [
    createHash("sha256").update(token).digest("hex"),
  ]);
  await e.exec(`INSERT INTO members (id, status) VALUES ('alice', 'enabled'); INSERT INTO config (key, value) VALUES ('access.owner_member', 'alice');`);
  await e.query(`UPDATE access_tokens SET member_id = 'alice' WHERE name = 'k'`);
  const provider = new OAuthProvider({ engine: e });
  expect((await provider.verifyAccessToken(token)).clientId).toBe("k");
  await e.query(`UPDATE members SET status = 'disabled' WHERE id = 'alice'`);
  await expect(provider.verifyAccessToken(token)).rejects.toBeInstanceOf(InvalidTokenError);
});
