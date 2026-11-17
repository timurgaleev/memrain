import { getDaemon } from "../daemons/registry.ts";
import { SUBAGENT_JOB_KIND } from "./kinds.ts";

export interface JobActivity {
  worker: string;
  kind: string;
  phase: "start" | "end";
  ok?: boolean;
  latencyMs?: number;
}

const DAEMON_ID = /^daemon:([^:]+):/;

/** The name a job runs under on the live feed: its daemon, the assistant, or a plain worker. */
export function workerNameFor(job: { id: string; kind: string }): string {
  const daemon = DAEMON_ID.exec(job.id)?.[1];
  if (daemon && getDaemon(daemon)) return daemon;
  if (job.kind === SUBAGENT_JOB_KIND) return "assistant";
  return "worker";
}
