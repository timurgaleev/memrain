import { Storage } from "../core/storage.ts";
import { loadConfig } from "../core/config.ts";
import { applyForgottenErasure, planForgottenErasure, type ErasureTargets } from "../core/forgotten-erasure.ts";
import { withStorage } from "./with-storage.ts";
import type { Engine } from "../core/engine/interface.ts";

export interface EraseOptions extends ErasureTargets { sub: string; apply?: boolean; planHash?: string; storage?: Storage; owner?: string }

/** Count, and with `apply` delete, every chat thread and message of one owner a 2.x brain kept. */
async function eraseOwnerChat(engine: Engine, ownerKey: string, apply: boolean): Promise<{ threads: number; messages: number }> {
  return engine.transaction(async (tx) => {
    // scope: operator-only the operator's erase command, keyed by the owner it names
    const c = await tx.query<{ threads: number | string; messages: number | string }>(
      `SELECT (SELECT count(*) FROM chat_threads WHERE owner_key = $1)::int AS threads,
              (SELECT count(*) FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE t.owner_key = $1)::int AS messages`,
      [ownerKey],
    );
    const counts = { threads: Number(c.rows[0]?.threads ?? 0), messages: Number(c.rows[0]?.messages ?? 0) };
    if (apply) await tx.query(`DELETE FROM chat_threads WHERE owner_key = $1`, [ownerKey]);
    return counts;
  });
}

/** `erase chat --owner KEY [--apply]`: an owner's chat threads and messages. */
async function runEraseChat(opts: EraseOptions): Promise<number> {
  const owner = (opts.owner ?? "").trim();
  if (!owner || owner.length > 200) throw new Error("erase chat requires --owner KEY (the chat owner, e.g. operator)");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const counts = await eraseOwnerChat(storage.engine(), owner, opts.apply === true);
    console.log(JSON.stringify({ ok: true, dry_run: opts.apply !== true, owner, ...counts }, null, 2));
    return 0;
  }, { owned: !opts.storage, migrate: false });
}

export async function runErase(opts: EraseOptions): Promise<number> {
  if (opts.sub === "chat") return runEraseChat(opts);
  if (opts.sub !== "forgotten") throw new Error("Use erase forgotten with explicit fact IDs or deleted pages, or erase chat --owner KEY");
  if (opts.apply && !opts.planHash) throw new Error("Erasure apply requires the exact preview plan hash");
  const storage = opts.storage ?? new Storage(loadConfig());
  return withStorage(storage, async () => {
    const result = opts.apply ? await applyForgottenErasure(storage.engine(), opts, opts.planHash!)
      : await planForgottenErasure(storage.engine(), opts);
    console.log(JSON.stringify({ ok: result.blockers.length === 0, dry_run: !opts.apply, ...result }, null, 2));
    return result.blockers.length === 0 ? 0 : 2;
  }, { owned: !opts.storage, migrate: false });
}
