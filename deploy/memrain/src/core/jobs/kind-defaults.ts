/**
 * Wall-clock caps for the kinds memrain ships, used when neither the job row
 * nor the worker sets one. With lease renewal a live attempt holds its claim
 * for as long as it runs, so a handler that hangs would hold it forever; these
 * caps are what end it. Each is far above the kind's normal run time.
 */
import {
  CHRONICLE_EXTRACT_JOB_KIND,
  INGEST_CAPTURE_JOB_KIND,
  PAGE_MIRROR_JOB_KIND,
  REMEDIATION_JOB_KIND,
  TRANSCRIPTS_INGEST_JOB_KIND,
} from "./kinds.ts";

export const KIND_DEFAULT_TIMEOUT_MS: Readonly<Record<string, number>> = {
  [REMEDIATION_JOB_KIND]: 30 * 60_000,
  [PAGE_MIRROR_JOB_KIND]: 10 * 60_000,
  [CHRONICLE_EXTRACT_JOB_KIND]: 10 * 60_000,
  [INGEST_CAPTURE_JOB_KIND]: 5 * 60_000,
  [TRANSCRIPTS_INGEST_JOB_KIND]: 15 * 60_000,
};

/** The built-in cap for `kind`, or undefined when it has none. */
export function kindDefaultTimeoutMs(kind: string): number | undefined {
  return Object.hasOwn(KIND_DEFAULT_TIMEOUT_MS, kind)
    ? KIND_DEFAULT_TIMEOUT_MS[kind]
    : undefined;
}
