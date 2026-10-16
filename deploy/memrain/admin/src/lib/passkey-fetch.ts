// Passkey endpoints answer typed errors ({error: "<code>"}) that the pages
// turn into copy. passkeyFetch never redirects: a 401 on a pre-auth call is a
// failed ceremony, not an expired session. No DOM here, so the root test
// runner can load it.

import { errorCodeOf } from "./passkey.ts";

export interface PasskeyResponse<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  body: T & { error?: string };
}

export async function passkeyFetch<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<PasskeyResponse<T>> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: (body ?? {}) as T & { error?: string } };
}

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(code);
  }
}

export function expectOk<T>(r: PasskeyResponse<T>): T {
  if (!r.ok) throw new ApiError(errorCodeOf(r.status, r.body), r.status, r.body as Record<string, unknown>);
  return r.body;
}

