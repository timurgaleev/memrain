import { automationApi } from "../api-automation.ts";
import { describeError } from "../hooks.ts";
import { ApiError } from "../lib/passkey-fetch.ts";
import { connectorErrorCopy, safeAuthorizeUrl } from "../lib/automation.ts";

/** One line for a failed action: the connector routes' codes in words, anything else as it came. */
export function actionError(e: unknown): string {
  return e instanceof ApiError ? connectorErrorCopy(e.code, describeError(e)) : describeError(e);
}

/** Sends the browser to the provider's consent page, or says why it will not. */
export async function goToConsent(provider: string, sourceId: string, services: string[], accountId?: string): Promise<void> {
  const { authorize_url } = await automationApi.startConnect(provider, sourceId, services, accountId);
  const target = safeAuthorizeUrl(authorize_url);
  if (!target) throw new Error("The server returned a consent address that is not https. Nothing was opened.");
  window.location.assign(target);
}
