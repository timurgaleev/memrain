// The browser half of the WebAuthn ceremonies. SimpleWebAuthn does the
// encoding; this file only maps its failures onto the typed codes the pages
// already know (see passkeyErrorCopy).

import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { ApiError, expectOk, passkeyApi } from "../api.ts";

export class CeremonyError extends Error {
  constructor(readonly code: "cancelled" | "credential_exists" | "unsupported" | "ceremony_failed") {
    super(code);
  }
}

/** WebAuthn is present and the page is a secure context (https or localhost). */
export function passkeysUsableHere(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && browserSupportsWebAuthn();
}

function mapError(e: unknown): CeremonyError {
  if (e instanceof WebAuthnError) {
    if (e.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return new CeremonyError("credential_exists");
    if (e.code === "ERROR_CEREMONY_ABORTED") return new CeremonyError("cancelled");
  }
  // Cancel, timeout and "no passkey on this device" all surface as
  // NotAllowedError; the spec keeps them indistinguishable on purpose.
  if (e instanceof Error && (e.name === "NotAllowedError" || e.name === "AbortError")) return new CeremonyError("cancelled");
  if (e instanceof Error && e.name === "NotSupportedError") return new CeremonyError("unsupported");
  return new CeremonyError("ceremony_failed");
}

export async function register(optionsJSON: unknown): Promise<RegistrationResponseJSON> {
  try {
    return await startRegistration({ optionsJSON: optionsJSON as PublicKeyCredentialCreationOptionsJSON });
  } catch (e) {
    throw mapError(e);
  }
}

export async function authenticate(optionsJSON: unknown): Promise<AuthenticationResponseJSON> {
  try {
    return await startAuthentication({ optionsJSON: optionsJSON as PublicKeyCredentialRequestOptionsJSON });
  } catch (e) {
    throw mapError(e);
  }
}

/** Step-up: one passkey confirmation that makes this session fresh for 5 minutes. */
export async function reauthenticate(): Promise<void> {
  const { optionsJSON } = expectOk(await passkeyApi.reauthOptions());
  const response = await authenticate(optionsJSON);
  expectOk(await passkeyApi.reauthVerify(response));
}

/** Runs `fn`; on `reauth_required` confirms with a passkey once and retries. */
export async function withReauth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== "reauth_required") throw e;
  }
  await reauthenticate();
  return fn();
}

/** The typed code behind any failure a passkey action can throw. */
export function failureCode(e: unknown): string {
  if (e instanceof CeremonyError || e instanceof ApiError) return e.code;
  if (e instanceof TypeError) return "network";
  return "unknown";
}
