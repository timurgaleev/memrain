/**
 * Kind names for the job handlers memrain ships. They live apart from the
 * handler modules so the submit-side check in handlers.ts can name them
 * without importing each handler's dependencies.
 */
export const CHRONICLE_EXTRACT_JOB_KIND = "chronicle_extract";
export const INGEST_CAPTURE_JOB_KIND = "ingest_capture";
/** A session log pushed to POST /ingest, written as conversation pages. */
export const TRANSCRIPTS_INGEST_JOB_KIND = "transcripts_ingest";
export const REMEDIATION_JOB_KIND = "remediation";
export const PAGE_MIRROR_JOB_KIND = "page_mirror";
/**
 * The operator's agent loop. Deliberately NOT in BUILTIN_JOB_KINDS: it is
 * accepted only by a process that registered its handler, which serve does
 * only when MEMRAIN_AGENT_ENABLED=1, so a disabled install refuses the submit.
 */
export const SUBAGENT_JOB_KIND = "subagent";
