/**
 * Recorded Fireflies GraphQL responses (tests/fixtures/fireflies/recorded.json)
 * and a fake fetch that answers each request by its GraphQL operation. No
 * request leaves the process. Response shapes follow the Fireflies API docs
 * (https://docs.fireflies.ai/graphql-api/query/transcripts,
 * https://docs.fireflies.ai/fundamentals/errors); the values are invented.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../../src/core/connectors/client.ts";
import { toResponse, type Recorded } from "../github-recorded.ts";

const ALL = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "fireflies", "recorded.json"), "utf-8")) as Record<string, Recorded>;

export const FIREFLIES_GRAPHQL = ["https://api", "fireflies", "ai/graphql"].join(".");
/** An API key shape assembled at run time, so none sits in the source. */
export const FIREFLIES_KEY = ["ff", "key", "0123456789abcdef"].join("-");

export function ff(name: string): Recorded {
  const r = ALL[name];
  if (!r) throw new Error(`no recorded Fireflies response '${name}'`);
  return structuredClone(r);
}

export interface FirefliesRequest {
  operation: string;
  variables: Record<string, unknown>;
  authorization: string | null;
}

/** What the fake Fireflies answers; each handler returns a recorded response name or a Recorded. */
export interface FirefliesWorld {
  user?: () => string | Recorded;
  list?: (vars: Record<string, unknown>) => string | Recorded;
  ids?: (vars: Record<string, unknown>) => string | Recorded;
  transcript?: (id: string) => string | Recorded;
  exists?: (id: string) => string | Recorded;
}

export function firefliesFetch(world: FirefliesWorld, key = FIREFLIES_KEY): { fetch: FetchFn; requests: FirefliesRequest[] } {
  const requests: FirefliesRequest[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (url !== FIREFLIES_GRAPHQL || init.method !== "POST") return new Response("not found", { status: 404 });
    const authorization = new Headers(init.headers).get("authorization");
    const body = JSON.parse(String(init.body)) as { query: string; variables?: Record<string, unknown> };
    const operation = /^\s*query\s+(\w+)/.exec(body.query)?.[1] ?? "anonymous";
    const variables = body.variables ?? {};
    requests.push({ operation, variables, authorization });
    if (authorization !== `Bearer ${key}`) return toResponse(ff("auth-failed"));
    const pick = (r: string | Recorded | undefined): Response => {
      if (r === undefined) throw new Error(`unexpected Fireflies operation ${operation}`);
      return toResponse(typeof r === "string" ? ff(r) : r);
    };
    switch (operation) {
      case "FirefliesUser": return pick(world.user?.());
      case "FirefliesTranscripts": return pick(world.list?.(variables));
      case "FirefliesTranscriptIds": return pick(world.ids?.(variables));
      case "FirefliesTranscript": return pick(world.transcript?.(String(variables.id)));
      case "FirefliesTranscriptExists": return pick(world.exists?.(String(variables.id)));
      default: throw new Error(`unexpected Fireflies operation ${operation}`);
    }
  };
  return { fetch, requests };
}
