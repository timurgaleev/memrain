import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectorsStatus,
  credentialAad,
  kekFromBytes,
  loadKek,
  seal,
  unseal,
  VaultError,
} from "../src/core/connectors/vault.ts";

const kek = kekFromBytes(randomBytes(32));
const other = kekFromBytes(randomBytes(32));
const ACCOUNT = "4b0c6f0e-2a59-4a39-9d3e-0d7f1f0e7a11";
const SECRET = '{"access_token":"ya29.live-access","refresh_token":"1//live-refresh"}';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof VaultError ? e.code : `not a VaultError: ${String(e)}`;
  }
}

function flipByte(b64: string, at: number): string {
  const buf = Buffer.from(b64, "base64");
  buf[at] = buf[at]! ^ 0x01;
  return buf.toString("base64");
}

describe("connector vault", () => {
  it("round-trips a secret under its own AAD", () => {
    const aad = credentialAad(ACCOUNT, "test", kek.id);
    const sealed = seal(kek, SECRET, aad);
    expect(sealed.kek_id).toBe(kek.id);
    expect(sealed.ciphertext).not.toContain("live-access");
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("live");
    expect(unseal(kek, sealed, aad)).toBe(SECRET);
  });

  it("uses a fresh nonce for every seal", () => {
    const aad = credentialAad(ACCOUNT, "test", kek.id);
    const a = seal(kek, SECRET, aad);
    const b = seal(kek, SECRET, aad);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses a ciphertext, nonce or tag with one flipped bit", () => {
    const aad = credentialAad(ACCOUNT, "test", kek.id);
    const sealed = seal(kek, SECRET, aad);
    const len = Buffer.from(sealed.ciphertext, "base64").length;
    expect(codeOf(() => unseal(kek, { ...sealed, ciphertext: flipByte(sealed.ciphertext, 0) }, aad))).toBe("vault_tamper");
    expect(codeOf(() => unseal(kek, { ...sealed, ciphertext: flipByte(sealed.ciphertext, len - 1) }, aad))).toBe("vault_tamper");
    expect(codeOf(() => unseal(kek, { ...sealed, nonce: flipByte(sealed.nonce, 3) }, aad))).toBe("vault_tamper");
  });

  it("refuses a row moved to another account (AAD mismatch)", () => {
    const sealed = seal(kek, SECRET, credentialAad(ACCOUNT, "test", kek.id));
    const moved = credentialAad("9e2f5b1c-0000-4000-8000-0000000000ab", "test", kek.id);
    expect(codeOf(() => unseal(kek, sealed, moved))).toBe("vault_tamper");
    expect(codeOf(() => unseal(kek, sealed, credentialAad(ACCOUNT, "other", kek.id)))).toBe("vault_tamper");
  });

  it("names a wrong key without trying it, and never echoes the plaintext", () => {
    const aad = credentialAad(ACCOUNT, "test", kek.id);
    const sealed = seal(kek, SECRET, aad);
    let message = "";
    try {
      unseal(other, sealed, aad);
    } catch (e) {
      expect((e as VaultError).code).toBe("vault_wrong_key");
      message = (e as Error).message;
    }
    expect(message).not.toContain("live");
    expect(message).not.toContain(kek.key.toString("base64"));
  });

  it("refuses a forged kek_id that names the right key but a different one sealed it", () => {
    const aad = credentialAad(ACCOUNT, "test", other.id);
    const sealed = seal(other, SECRET, aad);
    expect(codeOf(() => unseal(kek, { ...sealed, kek_id: kek.id }, aad))).toBe("vault_tamper");
  });

  it("opens with any key from a keyring, picked by kek_id", () => {
    const aad = credentialAad(ACCOUNT, "test", other.id);
    const sealed = seal(other, SECRET, aad);
    expect(unseal([kek, other], sealed, aad)).toBe(SECRET);
  });
});

describe("connector KEK loading", () => {
  const b64 = randomBytes(32).toString("base64");

  it("is closed with no key, and says why", () => {
    const load = loadKek({});
    expect(load.kek).toBeNull();
    expect(connectorsStatus({ MEMRAIN_CONNECTORS_ENABLED: "1" })).toEqual({
      enabled: false, kekId: null, reason: expect.stringContaining("MEMRAIN_CONNECTOR_KEK"),
    });
  });

  it("is closed when the flag is off, even with a key", () => {
    const st = connectorsStatus({ MEMRAIN_CONNECTOR_KEK: b64 });
    expect(st.enabled).toBe(false);
    expect(st.reason).toContain("MEMRAIN_CONNECTORS_ENABLED");
  });

  it("opens with the flag and a 32-byte key, and the id is stable", () => {
    const st = connectorsStatus({ MEMRAIN_CONNECTORS_ENABLED: "1", MEMRAIN_CONNECTOR_KEK: b64 });
    expect(st.enabled).toBe(true);
    expect(st.kekId).toBe(kekFromBytes(Buffer.from(b64, "base64")).id);
    expect(st.kekId).not.toContain(b64);
  });

  it("rejects a key of the wrong length without echoing it", () => {
    const short = randomBytes(16).toString("base64");
    const load = loadKek({ MEMRAIN_CONNECTOR_KEK: short });
    expect(load.kek).toBeNull();
    expect("reason" in load ? load.reason : "").not.toContain(short);
  });

  it("reads a key file that only its owner can read, and refuses a shared one", () => {
    const dir = mkdtempSync(join(tmpdir(), "memrain-kek-"));
    try {
      const file = join(dir, "kek");
      writeFileSync(file, `${b64}\n`);
      chmodSync(file, 0o400);
      expect(loadKek({ MEMRAIN_CONNECTOR_KEK_FILE: file }).kek?.id).toBe(kekFromBytes(Buffer.from(b64, "base64")).id);
      chmodSync(file, 0o644);
      const shared = loadKek({ MEMRAIN_CONNECTOR_KEK_FILE: file });
      expect(shared.kek).toBeNull();
      expect("reason" in shared ? shared.reason : "").toContain("group or other");
      expect(loadKek({ MEMRAIN_CONNECTOR_KEK_FILE: join(dir, "missing") }).kek).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses both variables at once instead of guessing", () => {
    const load = loadKek({ MEMRAIN_CONNECTOR_KEK: b64, MEMRAIN_CONNECTOR_KEK_FILE: "/nonexistent" });
    expect(load.kek).toBeNull();
  });
});
