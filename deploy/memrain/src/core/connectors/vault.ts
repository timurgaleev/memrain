/**
 * The connector token vault: AES-256-GCM envelopes under a key-encryption key
 * (KEK) that never touches the database.
 *
 * Every envelope carries the id of the KEK that sealed it and is bound to its
 * row by additional authenticated data (AAD): a credential row copied onto
 * another account, or a ciphertext with one flipped bit, fails to open. The
 * KEK comes from `MEMRAIN_CONNECTOR_KEK` (base64) or `MEMRAIN_CONNECTOR_KEK_FILE`
 * (a file only its owner can read). With no usable key, connectors stay off:
 * nothing here falls back to storing a token in the clear.
 *
 * Errors carry a code and a fixed message. They never quote the plaintext, the
 * key or the AAD.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const KEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** A base64 key and a newline fit with room to spare; anything bigger is not a key. */
const MAX_KEK_FILE_BYTES = 1024;

export type VaultErrorCode = "vault_no_key" | "vault_wrong_key" | "vault_tamper";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export interface Kek {
  /** Public name of the key: a hash prefix, never the key itself. */
  readonly id: string;
  readonly key: Buffer;
}

/** One sealed value as stored: every field is base64 except `kek_id`. */
export interface Sealed {
  kek_id: string;
  nonce: string;
  /** Ciphertext with the 16-byte GCM tag appended. */
  ciphertext: string;
}

export function kekFromBytes(key: Buffer): Kek {
  if (key.length !== KEK_BYTES) throw new VaultError("vault_no_key", `connector key must be ${KEK_BYTES} bytes`);
  const id = createHash("sha256").update("memrain:connector-kek-id\0").update(key).digest("hex").slice(0, 16);
  return { id, key: Buffer.from(key) };
}

export type KekLoad = { kek: Kek } | { kek: null; reason: string };

function parseKey(raw: string, where: string): KekLoad {
  const text = raw.trim();
  if (text === "") return { kek: null, reason: `${where} is empty` };
  if (!/^[\w+/-]+={0,2}$/.test(text)) return { kek: null, reason: `${where} is not base64` };
  const key = Buffer.from(text, "base64");
  if (key.length !== KEK_BYTES) return { kek: null, reason: `${where} must decode to ${KEK_BYTES} bytes` };
  return { kek: kekFromBytes(key) };
}

/**
 * Load the KEK from the environment. Returns a reason instead of throwing, so
 * doctor and the connector gate can both say why connectors are off.
 */
export function loadKek(env: NodeJS.ProcessEnv = process.env): KekLoad {
  const inline = env.MEMRAIN_CONNECTOR_KEK;
  const file = env.MEMRAIN_CONNECTOR_KEK_FILE;
  if (inline !== undefined && inline !== "" && file !== undefined && file !== "") {
    return { kek: null, reason: "set MEMRAIN_CONNECTOR_KEK or MEMRAIN_CONNECTOR_KEK_FILE, not both" };
  }
  if (inline !== undefined && inline !== "") return parseKey(inline, "MEMRAIN_CONNECTOR_KEK");
  if (file === undefined || file === "") {
    return { kek: null, reason: "no connector key: set MEMRAIN_CONNECTOR_KEK or MEMRAIN_CONNECTOR_KEK_FILE" };
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    return { kek: null, reason: "MEMRAIN_CONNECTOR_KEK_FILE cannot be read" };
  }
  if (!st.isFile()) return { kek: null, reason: "MEMRAIN_CONNECTOR_KEK_FILE is not a regular file" };
  if ((st.mode & 0o077) !== 0) {
    return { kek: null, reason: "MEMRAIN_CONNECTOR_KEK_FILE is readable by group or other; chmod 0400 it" };
  }
  if (st.size > MAX_KEK_FILE_BYTES) return { kek: null, reason: "MEMRAIN_CONNECTOR_KEK_FILE is too large to be a key" };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { kek: null, reason: "MEMRAIN_CONNECTOR_KEK_FILE cannot be read" };
  }
  return parseKey(raw, "MEMRAIN_CONNECTOR_KEK_FILE");
}

/** On only when the variable says `1`, `true`, `on` or `yes`. */
function flagOn(v: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes((v ?? "").trim().toLowerCase());
}

/**
 * The one MEMRAIN_CONNECTORS_ENABLED switch, read the same way everywhere. On
 * its own it opens nothing: connectorsStatus also needs a usable key.
 */
export function connectorsSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.MEMRAIN_CONNECTORS_ENABLED);
}

export interface ConnectorsStatus {
  enabled: boolean;
  kekId: string | null;
  /** Why connectors are off; null when they are on. */
  reason: string | null;
}

/**
 * Connectors run only with `MEMRAIN_CONNECTORS_ENABLED` on AND a usable KEK.
 * Off by default, and closed whenever the key is missing or malformed.
 */
export function connectorsStatus(env: NodeJS.ProcessEnv = process.env): ConnectorsStatus {
  const load = loadKek(env);
  const kekId = load.kek?.id ?? null;
  if (!connectorsSwitchOn(env)) {
    return { enabled: false, kekId, reason: "connectors are off (MEMRAIN_CONNECTORS_ENABLED is not set)" };
  }
  if (load.kek === null) return { enabled: false, kekId: null, reason: load.reason };
  return { enabled: true, kekId, reason: null };
}

export function connectorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return connectorsStatus(env).enabled;
}

/** AAD of a connector credential: binds it to its account and provider. */
export function credentialAad(accountId: string, provider: string, kekId: string): string {
  return `memrain:connector-credential:v1|${accountId}|${provider}|${kekId}`;
}

/** AAD of a stored bring-your-own OAuth client secret. */
export function oauthClientAad(provider: string, clientId: string, kekId: string): string {
  return `memrain:connector-oauth-client:v1|${provider}|${clientId}|${kekId}`;
}

/** AAD of the PKCE verifier kept with a pending OAuth state. */
export function oauthStateAad(stateHash: string, provider: string, kekId: string): string {
  return `memrain:connector-oauth-state:v1|${stateHash}|${provider}|${kekId}`;
}

export function seal(kek: Kek, plaintext: string, aad: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek.key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { kek_id: kek.id, nonce: nonce.toString("base64"), ciphertext: body.toString("base64") };
}

/**
 * Open a sealed value with the key its `kek_id` names. A missing key is
 * `vault_wrong_key`; any authentication failure (changed byte, wrong AAD,
 * forged `kek_id`) is `vault_tamper`.
 */
export function unseal(keys: Kek | readonly Kek[], sealed: Sealed, aad: string): string {
  const ring = Array.isArray(keys) ? keys : [keys as Kek];
  const kek = ring.find((k) => k.id === sealed.kek_id);
  if (!kek) throw new VaultError("vault_wrong_key", "no loaded connector key matches this record");
  const nonce = Buffer.from(sealed.nonce, "base64");
  const body = Buffer.from(sealed.ciphertext, "base64");
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
    throw new VaultError("vault_tamper", "connector record failed authentication");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("vault_tamper", "connector record failed authentication");
  }
}
