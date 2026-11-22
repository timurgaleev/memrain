/**
 * `memrain waiting [--source ID] [--type T] [--limit N] [--stale] [--json]`
 * `memrain waiting sweep [--source ID] [--json]`
 * `memrain waiting done|drop <id> [--dry-run] [--json]`
 * `memrain waiting mute|unmute sender|thread <id> [--dry-run] [--json]`
 *
 * Who is waiting for a reply from the owner, whom the owner is waiting on,
 * what the owner promised, and which invitations want an answer: the open
 * loops the loops_sweep daemon found in mail, chat and calendar connector
 * pages. No model is involved and nothing is spent.
 *
 * The list refuses when the newest mail, chat or calendar sync is older than
 * 24 hours (or none ever ran): a stale list that looks clean is worse than no
 * list. `--stale` shows it anyway, marked stale.
 *
 * Exit codes: 0 done; 1 refused, usage error or unknown loop.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import {
  closeLoop, isLoopType, listLoops, LOOPS_MAX_SYNC_AGE_HOURS as WAITING_MAX_SYNC_AGE_HOURS, muteLoop, syncFreshness, sweepLoops, type OpenLoopRow,
} from "../core/loops/store.ts";
import { withStorage } from "./with-storage.ts";

export interface WaitingCmdOptions {
  /** undefined (list), `sweep`, `done`, `drop`, `mute`, `unmute`. */
  sub: string | undefined;
  /** `sender` or `thread` for mute/unmute. */
  target?: string;
  id?: string;
  sourceId?: string;
  type?: string;
  limit?: number;
  stale?: boolean;
  /** done/drop/mute/unmute: report what would change, write nothing. */
  dryRun?: boolean;
  json?: boolean;
  configPath?: string;
  /** An open Storage owned by the caller. */
  storage?: Storage;
  now?: () => Date;
}

const USAGE = "usage: memrain waiting [--source ID] [--type T] [--limit N] [--stale] | sweep | done|drop <id> [--dry-run] | mute|unmute sender|thread <id> [--dry-run]";

function fail(msg: string, json: boolean | undefined): number {
  if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`memrain waiting: ${msg}`);
  return 1;
}

function line(l: OpenLoopRow): string {
  const due = l.due_at ? `, due ${l.due_at.slice(0, 16).replace("T", " ")}` : "";
  return `#${l.id} [${l.source_id}] ${l.summary} (since ${l.opened_at.slice(0, 10)}${due})`;
}

const FIX = "Reconnect or re-enable the account in Admin → Connections, and check that connector_sync is enabled "
  + "(`bun run src/cli.ts daemons status`; inside the container: `docker exec deploy-memrain-1 bun run src/cli.ts daemons status`). "
  + "Pass --stale to see the list anyway.";

function parseId(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export async function runWaiting(opts: WaitingCmdOptions): Promise<number> {
  const sub = opts.sub;
  if (sub !== undefined && !["sweep", "done", "drop", "mute", "unmute"].includes(sub)) return fail(USAGE, opts.json);
  if (opts.type !== undefined && !isLoopType(opts.type)) return fail(`unknown --type '${opts.type}'`, opts.json);
  if ((sub === "mute" || sub === "unmute") && opts.target !== "sender" && opts.target !== "thread") {
    return fail(`${sub}: say what to ${sub}: sender or thread`, opts.json);
  }
  // A preview flag a subcommand would ignore must refuse, never run the write.
  if (opts.dryRun && (sub === undefined || sub === "sweep")) return fail(`--dry-run applies to done, drop, mute and unmute`, opts.json);
  const id = parseId(opts.id);
  if ((sub === "done" || sub === "drop" || sub === "mute" || sub === "unmute") && id === null) {
    return fail(`${sub}: a loop id is required (see \`memrain waiting\`)`, opts.json);
  }
  const now = opts.now ?? (() => new Date());
  const scope = opts.sourceId !== undefined ? [opts.sourceId] : undefined;
  const storage = opts.storage ?? new Storage(loadConfig(opts.configPath));

  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (sub === "sweep") {
      const sources = opts.sourceId !== undefined ? [opts.sourceId]
        // scope: operator-only the local CLI sweeps every source that has thread states
        : (await engine.query<{ source_id: string }>(`SELECT DISTINCT source_id FROM loop_threads ORDER BY source_id`)).rows.map(r => r.source_id);
      const results = [];
      for (const source of sources) results.push({ source_id: source, ...await sweepLoops(engine, source, now()) });
      if (opts.json) console.log(JSON.stringify({ ok: true, swept: results }, null, 2));
      else if (results.length === 0) console.log("no connector thread states to sweep yet");
      else for (const r of results) console.log(`${r.source_id}: ${r.threads} thread(s), ${r.opened} opened, ${r.closed} closed`);
      return 0;
    }
    if (sub === "done" || sub === "drop") {
      const closed = await closeLoop(engine, scope, id!, sub === "done" ? "done" : "dropped", { dryRun: opts.dryRun === true });
      if (!closed) return fail(`no open loop ${id}${opts.sourceId ? ` in ${opts.sourceId}` : ""}`, opts.json);
      if (opts.json) console.log(JSON.stringify({ ok: true, ...(opts.dryRun ? { dry_run: true } : {}), loop: closed }, null, 2));
      else console.log(`${opts.dryRun ? "would close as " : ""}${sub === "done" ? "done" : "dropped"}: #${id}`);
      return 0;
    }
    if (sub === "mute" || sub === "unmute") {
      const r = await muteLoop(engine, scope, id!, opts.target as "sender" | "thread", sub === "mute", { dryRun: opts.dryRun === true, now: now() });
      if (!r) return fail(`no loop ${id}${opts.sourceId ? ` in ${opts.sourceId}` : ""}`, opts.json);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...r }, null, 2));
        return 0;
      }
      const list = (label: string, xs: number[] | undefined) => (xs && xs.length > 0 ? `; ${label}: ${xs.map(x => `#${x}`).join(" ")}` : "");
      const head = `${opts.dryRun ? `would ${sub}` : `${sub}d`} the ${r.kind} of #${id}${r.changed ? "" : " (no change)"}`;
      console.log(sub === "mute"
        ? `${head}${list(opts.dryRun ? "would close" : "closed", opts.dryRun ? r.would_close : r.closed)}`
        : `${head}${list("reopened", r.reopened)}${list("answered", r.answered)}${list("still muted", r.stayed_muted)}${list("unverifiable", r.unverifiable)}`);
      return 0;
    }

    const fresh = await syncFreshness(engine, scope, now(), WAITING_MAX_SYNC_AGE_HOURS);
    const ageHours = fresh.newest === null ? null : Math.floor((now().getTime() - Date.parse(fresh.newest)) / 3_600_000);
    const stale = ageHours === null || ageHours >= WAITING_MAX_SYNC_AGE_HOURS;
    if (stale && !opts.stale) {
      const why = fresh.newest === null
        ? "no mail, chat or calendar connector has synced yet"
        : `the newest mail, chat or calendar sync is ${ageHours} h old (${fresh.newest}); the list would be stale`;
      const accounts = fresh.stale.map(a => `  ${a.source_id} (${a.provider}): ${a.status}, last clean sync ${a.last_success_at ?? "never"}`);
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: why, stale_accounts: fresh.stale, fix: FIX }, null, 2));
      } else {
        console.error(`memrain waiting: ${why}.`);
        for (const a of accounts) console.error(a);
        console.error(FIX);
      }
      return 1;
    }
    const loops = await listLoops(engine, scope, {
      ...(opts.type !== undefined ? { loopType: opts.type as OpenLoopRow["loop_type"] } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, stale, newest_sync: fresh.newest, stale_accounts: fresh.stale, loops }, null, 2));
      return 0;
    }
    if (stale) console.log(`(stale: the newest mail, chat or calendar sync is ${fresh.newest ?? "never"})`);
    // Another account being fresh does not make this one's loops complete.
    if (!stale && fresh.stale.length > 0) {
      console.log(`(behind: ${fresh.stale.map(a => `${a.source_id} (${a.provider}): ${a.status}`).join("; ")}; its loops may be missing)`);
    }
    if (loops.length === 0) console.log("nobody is waiting: no open loops");
    for (const l of loops) console.log(line(l));
    return 0;
  }, { owned: opts.storage === undefined });
}
