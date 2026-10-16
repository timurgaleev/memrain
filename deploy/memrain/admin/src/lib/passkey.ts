// Passkey sign-in helpers the pages share. Kept free of DOM, React and the
// WebAuthn library so the root test runner can load it; the ceremonies live in
// passkey-ceremony.ts.

import type { RouteName } from "./route.ts";

// A setup token is 32 random bytes in base64url (43 chars); the bounds leave
// room for a format change without accepting arbitrary text.
const TOKEN_SHAPE = /^[\w-]{20,64}$/;

/** The token in `#enroll/<token>`, or null when the hash carries none. */
export function parseEnrollToken(hash: string): string | null {
  let s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (s.startsWith("/")) s = s.slice(1);
  if (!s.startsWith("enroll/")) return null;
  const token = s.slice("enroll/".length);
  return TOKEN_SHAPE.test(token) ? token : null;
}

// The setup token leaves the URL before the first render (main.tsx) and waits
// here, in memory only, until the person clicks "Create passkey".
let pendingEnrollToken: string | null = null;
let enrollSource: "link" | "recovery" | null = null;

export function setPendingEnrollToken(token: string | null): void {
  pendingEnrollToken = token;
  if (token !== null) enrollSource = "link";
}

export function pendingEnrollTokenValue(): string | null {
  return pendingEnrollToken;
}

export function setEnrollSource(source: "link" | "recovery" | null): void {
  enrollSource = source;
}

export function enrollSourceValue(): "link" | "recovery" | null {
  return enrollSource;
}

/** Routes that render before sign-in and must not trigger authenticated fetches. */
export function isPreAuthRoute(name: RouteName): boolean {
  return name === "login" || name === "enroll";
}

/** Uppercase, without spaces or dashes: what the server hashes. */
export function normalizeRecoveryInput(s: string): string {
  return s.toUpperCase().replace(/[\s-]+/g, "");
}

/** The text a person saves: one code per line, no host name or account detail. */
export function formatRecoveryCodes(codes: readonly string[]): string {
  return [
    "memrain admin recovery codes",
    "Each code works once. Use one if you lose access to all your passkeys.",
    "",
    ...codes,
    "",
  ].join("\n");
}

const COPY: Record<string, string> = {
  invalid_token: "This link was already used or has expired. Ask your operator for a new one.",
  invalid_code: "That recovery code is not valid, or it was already used.",
  cancelled: "Nothing was created. You can try again for the next 15 minutes.",
  login_cancelled: "Sign-in was cancelled. Try again when you are ready.",
  grant_lost: "Something interrupted the setup. Try the link again in 15 minutes, or ask for a new one.",
  no_grant: "This setup session has ended. Open the setup link again, or use a recovery code.",
  passkey_failed: "That passkey was not accepted. Try again, or use a recovery code.",
  passkey_unconfigured: "Passkey sign-in is not set up on this server yet. The operator needs to set MEMRAIN_PUBLIC_URL.",
  credential_exists: "This device already has a passkey for this brain. Use it to sign in, or pick another device.",
  slowed: "Too many failed attempts from this network. Wait 15 minutes and try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  reauth_required: "Confirm it is you with your passkey, then try again.",
  cooldown: "This passkey was added recently. For its first 24 hours it cannot do this; use an older passkey or ask your operator.",
  last_passkey: "This is your only passkey. Removing it leaves only recovery codes and the operator's access.",
  unsupported: "This browser cannot create or use passkeys here. Open the link in Safari or Chrome on the device you want to use.",
  ceremony_failed: "Your device could not complete the passkey step. Try again, or try another device.",
  network: "The server could not be reached. Check your connection and try again.",
};

/** Plain-language copy for a typed error code from the passkey endpoints. */
export function passkeyErrorCopy(code: string | null | undefined): string {
  if (code && Object.hasOwn(COPY, code)) return COPY[code]!;
  return "Something went wrong. Try again in a moment.";
}

/** The typed error code a passkey response carries, mapping bare statuses. */
export function errorCodeOf(status: number, body: unknown): string {
  const code = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (typeof code === "string" && code !== "") return code;
  if (status === 429) return "rate_limited";
  if (status === 503) return "passkey_unconfigured";
  return `http_${status}`;
}

const EVENT_LABELS: Record<string, string> = {
  "setup_link.issued": "Setup link created",
  "setup_link.redeemed": "Setup link opened",
  "setup_link.redeem_failed": "Setup link refused",
  "setup_link.revoked": "Setup links cancelled",
  "passkey.registered": "Passkey added",
  "passkey.register_failed": "Passkey not added",
  "passkey.login": "Signed in with a passkey",
  "passkey.login_failed": "Passkey sign-in failed",
  "passkey.counter_regression": "Passkey looked copied and was refused",
  "passkey.renamed": "Passkey renamed",
  "passkey.revoked": "Passkey removed",
  "passkey.reauth": "Confirmed with a passkey",
  "passkey.reauth_failed": "Passkey confirmation failed",
  "recovery.issued": "Recovery codes issued",
  "recovery.regenerated": "Recovery codes replaced",
  "recovery.used": "Recovery code used",
  "recovery.failed": "Recovery code refused",
  "notice.acked": "Security notice dismissed",
  rate_limited: "Attempts slowed down",
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

/** An array under `key`, or the body itself when the server answers a bare list. */
export function listOf<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}
