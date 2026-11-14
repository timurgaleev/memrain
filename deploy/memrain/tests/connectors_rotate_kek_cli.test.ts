import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { registerSource } from "../src/core/sources.ts";
import { createAccount, readCredential, storeCredential } from "../src/core/connectors/accounts.ts";
import { kekFromBytes } from "../src/core/connectors/vault.ts";
import { runConnectors } from "../src/commands/connectors.ts";

const OLD = randomBytes(32);
const NEW = randomBytes(32);
const TOKENS = { access_token: "cli-live-access-token", refresh_token: "cli-live-refresh-token" };

describe("memrain connectors rotate-kek", () => {
  const dir = mkdtempSync(join(tmpdir(), "memrain-rotate-kek-"));
  const cfgPath = join(dir, ".memex", "config.json");
  const oldFile = join(dir, "old.kek");
  const newFile = join(dir, "new.kek");
  let accountId = "";
  let log: ReturnType<typeof spyOn>;
  let err: ReturnType<typeof spyOn>;

  const open = () => new Storage(JSON.parse(readFileSync(cfgPath, "utf-8")));

  beforeAll(async () => {
    mkdirSync(join(dir, ".memex"), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({
      database: { type: "pglite", path: join(dir, ".memex", "brain.pglite") },
      embedding: { provider: "bedrock-titan", model: "amazon.titan-embed-text-v2:0", region: "eu-west-1" },
      storage: {},
    }));
    writeFileSync(oldFile, OLD.toString("base64"));
    writeFileSync(newFile, NEW.toString("base64"));
    chmodSync(oldFile, 0o400);
    chmodSync(newFile, 0o400);
    const s = open();
    await s.init();
    try {
      const e = s.engine();
      await registerSource(e, { id: "inbox", kind: "mailbox", pathPrefix: "/inbox" });
      const acct = await createAccount(e, { sourceId: "inbox", provider: "test", services: ["mail"], principalRef: "admin:operator", accountLabel: "a@example.test" });
      accountId = acct.id;
      await storeCredential(e, kekFromBytes(OLD), acct, TOKENS, { scopes: ["read"], expiresAt: null });
    } finally {
      await s.close();
    }
  });
  beforeEach(() => {
    log = spyOn(console, "log").mockImplementation(() => {});
    err = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const printed = () => JSON.stringify([...log.mock.calls, ...err.mock.calls]);

  it("needs both key files and refuses a shared one", async () => {
    expect(await runConnectors({ sub: "rotate-kek", configPath: cfgPath, oldKekFile: oldFile })).toBe(1);
    chmodSync(newFile, 0o644);
    expect(await runConnectors({ sub: "rotate-kek", configPath: cfgPath, oldKekFile: oldFile, newKekFile: newFile })).toBe(1);
    expect(printed()).toContain("group or other");
    chmodSync(newFile, 0o400);
    expect(await runConnectors({ sub: "rotate-kek", configPath: cfgPath, oldKekFile: oldFile, newKekFile: oldFile })).toBe(1);
  });

  it("re-seals every row under the new key and prints counts, never key material", async () => {
    expect(await runConnectors({ sub: "rotate-kek", configPath: cfgPath, oldKekFile: oldFile, newKekFile: newFile, json: true })).toBe(0);
    const out = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(out).toEqual({ ok: true, from: kekFromBytes(OLD).id, to: kekFromBytes(NEW).id, credentials: 1, oauth_clients: 0, oauth_states: 0 });
    expect(printed()).not.toContain(NEW.toString("base64"));
    expect(printed()).not.toContain("cli-live");
    const s = open();
    await s.init();
    try {
      expect((await readCredential(s.engine(), kekFromBytes(NEW), accountId))?.tokens).toEqual(TOKENS);
    } finally {
      await s.close();
    }
  });
});
