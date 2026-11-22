/**
 * Gmail send-as aliases: the other addresses the account sends from (and so
 * receives at), read from `users.settings.sendAs.list`, which `gmail.readonly`
 * allows (developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/list).
 * Mail to an alias is mail to the account: it opens a reply-owed loop, and an
 * alias is never a counterparty or a person.
 *
 * The list is kept in the account config (`sendas_aliases`, with the time of
 * the last check in `sendas_checked_at`) and asked for again at most once a
 * day, at the start of a Gmail run. A failed check keeps the stored list: a
 * passing 403 or outage must not make the account's own addresses strangers.
 */
import type { ConnectorClient } from "../client.ts";
import type { Engine } from "../../engine/interface.ts";
import { setAccountConfig } from "../accounts.ts";
import { SENDAS_ALIASES } from "../model.ts";

export const SENDAS_CHECKED_AT = "sendas_checked_at";
export const SENDAS_REFRESH_MS = 24 * 3_600_000;
export const MAX_SENDAS_ALIASES = 50;
const MAX_ADDRESS = 320;
/** One local part, one domain with a dot, nothing that could be a display name or a second address. */
const ADDRESS_RE = /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/;
const SENDAS_PATH = "/gmail/v1/users/me/settings/sendAs";

/** A bare address, lowercased, or null for anything else. */
function aliasAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  return text.length <= MAX_ADDRESS && ADDRESS_RE.test(text) ? text : null;
}

/**
 * The aliases a sendAs listing names: valid addresses only, lowercased,
 * deduplicated, at most MAX_SENDAS_ALIASES. Null for a body that is not a
 * listing; one without `sendAs` counts as that too, since Gmail always lists
 * the primary address.
 */
export function parseSendAs(body: unknown): string[] | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const list = (body as { sendAs?: unknown }).sendAs;
  if (!Array.isArray(list)) return null;
  const out = new Set<string>();
  for (const entry of list) {
    const a = entry !== null && typeof entry === "object" ? aliasAddress((entry as { sendAsEmail?: unknown }).sendAsEmail) : null;
    if (a !== null) out.add(a);
    if (out.size >= MAX_SENDAS_ALIASES) break;
  }
  return [...out];
}

/** The aliases stored in an account config; whatever is not a valid list reads as none. */
export function storedSendAs(config: Readonly<Record<string, unknown>> | undefined): string[] {
  const raw = config?.[SENDAS_ALIASES];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(aliasAddress).filter((a): a is string => a !== null))].slice(0, MAX_SENDAS_ALIASES);
}

function due(config: Readonly<Record<string, unknown>> | undefined, now: number): boolean {
  const at = config?.[SENDAS_CHECKED_AT];
  const t = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return !Number.isFinite(t) || now - t >= SENDAS_REFRESH_MS || t > now;
}

/**
 * The account's send-as aliases for this run: asked of Gmail when the last
 * check is a day old (or never happened) and stored, otherwise the stored list.
 * A refused or unreadable answer keeps the stored list and still records the
 * check, so a mailbox that never allows the call is asked once a day, not
 * every run.
 */
export async function refreshSendAs(
  client: ConnectorClient,
  engine: Engine,
  account: { id: string; config?: Readonly<Record<string, unknown>> },
  now: number,
): Promise<string[]> {
  const stored = storedSendAs(account.config);
  if (!due(account.config, now)) return stored;
  const res = await client.get(SENDAS_PATH);
  const fresh = res.class === "ok" ? parseSendAs(res.body) : null;
  const checkedAt = new Date(now).toISOString();
  if (fresh === null) {
    console.warn(`[connectors] gmail send-as aliases unavailable for account ${account.id} (${res.error ?? "unreadable response"}); keeping the stored list`);
    await setAccountConfig(engine, account.id, { [SENDAS_CHECKED_AT]: checkedAt });
    return stored;
  }
  await setAccountConfig(engine, account.id, { [SENDAS_ALIASES]: fresh, [SENDAS_CHECKED_AT]: checkedAt });
  return fresh;
}
