export type RoomId =
  | "reception"
  | "archive"
  | "writing"
  | "mailroom"
  | "library"
  | "night_shift"
  | "waiting_board"
  | "post_office"
  | "assistant_desk"
  | "back_office"
  | "break_room";

const WRITE_TOOLS = new Set([
  "page_put",
  "page_append",
  "page_edit",
  "page_delete",
  "page_rename",
  "page_restore",
  "page_revert",
  "add_fact",
  "add_tag",
  "remove_tag",
  "forget_fact",
  "link",
  "unlink",
  "takes_add",
  "takes_update",
  "put_raw_data",
  "log_ingest",
  "add_timeline_event",
  "set_take_status",
  "takes_resolve",
  "ontology_propose",
  "log_friction",
  "index",
  "extract_facts",
  "think",
  "retry_job",
  "chronicle_backfill",
]);

const JOB_ROOM: Record<string, RoomId> = {
  connector_sync: "mailroom",
  cycle: "night_shift",
  loops_sweep: "waiting_board",
  notifications: "post_office",
  assistant: "assistant_desk",
  worker: "library",
};

export function roomFor(e: { kind: "tool" | "job"; agent: string; operation: string }): RoomId {
  if (e.kind === "job") return JOB_ROOM[e.agent] ?? "back_office";
  return WRITE_TOOLS.has(e.operation) ? "writing" : "archive";
}

export const ROOM_PHRASE: Record<RoomId, string> = {
  reception: "arriving at reception",
  archive: "searching memory",
  writing: "writing to memory",
  mailroom: "reading new mail",
  library: "indexing pages",
  night_shift: "running the nightly cycle",
  waiting_board: "checking follow-ups",
  post_office: "sending notifications",
  assistant_desk: "working on a request",
  back_office: "running a background task",
  break_room: "idle",
};

export const WORKER_LABEL: Record<string, string> = {
  connector_sync: "Mail sync",
  cycle: "Night shift",
  loops_sweep: "Follow-ups",
  notifications: "Notifier",
  assistant: "Assistant",
  worker: "Librarian",
};
