/**
 * A software WebAuthn authenticator for tests: a P-256 key from node:crypto,
 * CBOR and COSE encoding from @simplewebauthn/server/helpers, signatures from
 * crypto.sign. Every field a relying party checks (origin, rpIdHash, flags,
 * counter, challenge, userHandle, type) can be set independently, so a test can
 * break exactly one of them.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { cose, isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  origin?: string;
  rpID?: string;
  challenge?: string;
  type?: string;
  uv?: boolean;
  counter?: number;
  userHandle?: string;
}

type Bytes = Uint8Array<ArrayBuffer>;
type Cbor = Parameters<typeof isoCBOR.encode>[0];

const sha256 = (b: Uint8Array | string): Bytes => new Uint8Array(createHash("sha256").update(b).digest());
const b64u = (b: Bytes): string => isoBase64URL.fromBuffer(b);

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export class SoftAuthenticator {
  readonly credentialId: string;
  /** The counter the next ceremony reports, unless overridden. */
  counter = 0;
  /** Synced passkey (BE+BS) by default; set false for a device-bound one. */
  synced = true;
  userHandle: string | null = null;
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Bytes;

  constructor(readonly origin: string, readonly rpID: string) {
    this.credentialId = b64u(new Uint8Array(randomBytes(16)));
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const key: Cbor = new Map<number, Cbor>([
      [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
      [cose.COSEKEYS.alg, cose.COSEALG.ES256],
      [cose.COSEKEYS.crv, cose.COSECRV.P256],
      [cose.COSEKEYS.x, isoBase64URL.toBuffer(jwk.x)],
      [cose.COSEKEYS.y, isoBase64URL.toBuffer(jwk.y)],
    ]);
    this.cosePublicKey = isoCBOR.encode(key);
  }

  private flags(uv: boolean, attested: boolean): number {
    let f = FLAG_UP;
    if (uv) f |= FLAG_UV;
    if (this.synced) f |= FLAG_BE | FLAG_BS;
    if (attested) f |= FLAG_AT;
    return f;
  }

  private authData(rpID: string, flags: number, counter: number, attested: Bytes | null): Bytes {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, counter);
    return concat(sha256(rpID), new Uint8Array([flags]), ctr, ...(attested ? [attested] : []));
  }

  private clientData(type: string, challenge: string, origin: string): Bytes {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  register(options: PublicKeyCredentialCreationOptionsJSON, o: CeremonyOverrides = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const credId = isoBase64URL.toBuffer(this.credentialId);
    const idLen = new Uint8Array(2);
    new DataView(idLen.buffer).setUint16(0, credId.length);
    const attested = concat(new Uint8Array(16), idLen, credId, this.cosePublicKey);
    const authData = this.authData(o.rpID ?? this.rpID, this.flags(o.uv ?? true, true), o.counter ?? this.counter, attested);
    const attestationObject = isoCBOR.encode(new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]));
    const clientDataJSON = this.clientData(o.type ?? "webauthn.create", o.challenge ?? options.challenge, o.origin ?? this.origin);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  assert(options: PublicKeyCredentialRequestOptionsJSON, o: CeremonyOverrides = {}): AuthenticationResponseJSON {
    const authData = this.authData(o.rpID ?? this.rpID, this.flags(o.uv ?? true, false), o.counter ?? this.counter, null);
    const clientDataJSON = this.clientData(o.type ?? "webauthn.get", o.challenge ?? options.challenge, o.origin ?? this.origin);
    const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(new Uint8Array(signature)),
        ...(o.userHandle ?? this.userHandle ? { userHandle: (o.userHandle ?? this.userHandle)! } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
