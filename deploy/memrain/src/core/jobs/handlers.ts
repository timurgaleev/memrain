/**
 * Job handler registry.
 *
 * Process-local — each memrain process registers the handlers it knows
 * how to run. The worker dispatches by `kind`. Unknown kinds fail with
 * a clear error so a forgotten registration surfaces immediately rather
 * than silently piling up in the table.
 */
import {
  CHRONICLE_EXTRACT_JOB_KIND,
  INGEST_CAPTURE_JOB_KIND,
  PAGE_MIRROR_JOB_KIND,
  REMEDIATION_JOB_KIND,
  TRANSCRIPTS_INGEST_JOB_KIND,
} from "./kinds.ts";
import type { JobHandler } from "./types.ts";

const REGISTRY = new Map<string, JobHandler>();

/** Kind-name shape shared by registration and submit-side validation. */
export function isValidKind(kind: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(kind);
}

export function registerHandler(kind: string, fn: JobHandler): void {
  if (!kind || !isValidKind(kind)) {
    throw new Error(
      `registerHandler: invalid kind '${kind}' (lowercase, [a-z0-9._-])`,
    );
  }
  REGISTRY.set(kind, fn);
}

export function getHandler(kind: string): JobHandler | undefined {
  return REGISTRY.get(kind);
}

/**
 * Kinds memrain ships a handler for. Submit-side validation needs this static
 * list because `memrain call` runs in a process that never registers serve's
 * handlers; the lifecycle smoke kind stays out on purpose, since only the
 * self-test that registers it should ever enqueue it.
 */
export const BUILTIN_JOB_KINDS: ReadonlySet<string> = new Set([
  CHRONICLE_EXTRACT_JOB_KIND,
  INGEST_CAPTURE_JOB_KIND,
  REMEDIATION_JOB_KIND,
  PAGE_MIRROR_JOB_KIND,
  TRANSCRIPTS_INGEST_JOB_KIND,
]);

/** True when a worker could run this kind: built in, or registered here. */
export function isKnownJobKind(kind: string): boolean {
  return REGISTRY.has(kind) || BUILTIN_JOB_KINDS.has(kind);
}

/** Every kind a submit may name, sorted — for refusal messages. */
export function knownJobKinds(): string[] {
  return [...new Set([...BUILTIN_JOB_KINDS, ...REGISTRY.keys()])].sort();
}

export function listHandlers(): string[] {
  return Array.from(REGISTRY.keys()).sort();
}

/** Test-only — clears the registry between cases. */
export function _resetHandlersForTesting(): void {
  REGISTRY.clear();
}
