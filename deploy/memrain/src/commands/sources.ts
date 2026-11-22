/**
 * `memrain sources <subcommand>` — operator CRUD over the sources
 * table. Pre-req for the deferred Gmail / GCal / code recipes
 * (TODO.md "External-dependency roadmap").
 *
 * Subcommands:
 *   list   [--kind K]                            JSON list of sources
 *   show   <id>                                  full row for one source
 *   register <id> --kind K --path-prefix P
 *            [--description D] [--sync-policy P] [--indexed-policy P]
 *            [--rate-limit-per-minute N] [--respect-quiet-hours]
 *            [--boost-weight N]
 *   update <id> [--kind K] [--path-prefix P] [--description D]
 *               [--sync-policy P] [--indexed-policy P]
 *               [--rate-limit-per-minute N] [--respect-quiet-hours]
 *               [--no-respect-quiet-hours] [--boost-weight N]
 *   delete <id>                                  refuses if documents
 *                                                still reference it
 *   owner-only <id> [on|off]                     show or set the owner-only flag
 *   federate <id> / unfederate <id>              whether unscoped reads reach it
 *   provenance [--apply]                         record origins of older derived rows
 */
import { Storage } from "../core/storage.ts";
import { provenanceBackfill, provenanceBackfilled, setSourceOwnerOnly } from "../core/owner-only.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import {
  registerSource,
  listSources,
  getSource,
  updateSource,
  deleteSource,
  sourceReferences,
  setSourceFederated,
  SOURCE_KINDS,
  type SourceKind,
  type SyncPolicy,
  type IndexedPolicy,
} from "../core/sources.ts";

export type SourcesSub =
  | "list"
  | "show"
  | "register"
  | "update"
  | "delete";

export interface SourcesCmdOptions {
  sub: SourcesSub;
  id?: string;
  kind?: SourceKind;
  pathPrefix?: string;
  syncPolicy?: SyncPolicy;
  indexedPolicy?: IndexedPolicy;
  rateLimitPerMinute?: number;
  respectQuietHours?: boolean;
  boostWeight?: number;
  description?: string | null;
}

export async function runSources(opts: SourcesCmdOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.engine();
    switch (opts.sub) {
      case "list": {
        const lOpts: Parameters<typeof listSources>[1] = {};
        if (opts.kind) lOpts.kind = opts.kind;
        const rows = await listSources(engine, lOpts);
        console.log(
          JSON.stringify({ ok: true, count: rows.length, rows }, null, 2),
        );
        return;
      }
      case "show": {
        if (!opts.id) throw new Error("memrain sources show: <id> is required");
        const row = await getSource(engine, opts.id);
        if (!row) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, source: row }, null, 2));
        return;
      }
      case "register": {
        if (!opts.id) throw new Error("memrain sources register: <id> is required");
        if (!opts.kind) throw new Error("memrain sources register: --kind is required");
        if (!opts.pathPrefix) throw new Error("memrain sources register: --path-prefix is required");
        const rOpts: Parameters<typeof registerSource>[1] = {
          id: opts.id,
          kind: opts.kind,
          pathPrefix: opts.pathPrefix,
        };
        if (opts.syncPolicy) rOpts.syncPolicy = opts.syncPolicy;
        if (opts.indexedPolicy) rOpts.indexedPolicy = opts.indexedPolicy;
        if (opts.rateLimitPerMinute !== undefined)
          rOpts.rateLimitPerMinute = opts.rateLimitPerMinute;
        if (opts.respectQuietHours !== undefined)
          rOpts.respectQuietHours = opts.respectQuietHours;
        if (opts.boostWeight !== undefined) rOpts.boostWeight = opts.boostWeight;
        if (opts.description !== undefined) rOpts.description = opts.description;
        const row = await registerSource(engine, rOpts);
        console.log(JSON.stringify({ ok: true, source: row }, null, 2));
        return;
      }
      case "update": {
        if (!opts.id) throw new Error("memrain sources update: <id> is required");
        const uOpts: Parameters<typeof updateSource>[1] = { id: opts.id };
        if (opts.kind) uOpts.kind = opts.kind;
        if (opts.pathPrefix) uOpts.pathPrefix = opts.pathPrefix;
        if (opts.syncPolicy) uOpts.syncPolicy = opts.syncPolicy;
        if (opts.indexedPolicy) uOpts.indexedPolicy = opts.indexedPolicy;
        if (opts.rateLimitPerMinute !== undefined)
          uOpts.rateLimitPerMinute = opts.rateLimitPerMinute;
        if (opts.respectQuietHours !== undefined)
          uOpts.respectQuietHours = opts.respectQuietHours;
        if (opts.boostWeight !== undefined) uOpts.boostWeight = opts.boostWeight;
        if (opts.description !== undefined) uOpts.description = opts.description;
        const row = await updateSource(engine, uOpts);
        if (!row) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify({ ok: true, source: row }, null, 2));
        return;
      }
      case "delete": {
        if (!opts.id) throw new Error("memrain sources delete: <id> is required");
        if (!(await getSource(engine, opts.id))) {
          console.log(JSON.stringify({ ok: false, error: "not-found", id: opts.id }, null, 2));
          process.exitCode = 1;
          return;
        }
        const ok = await deleteSource(engine, opts.id);
        const referents = ok ? {} : await sourceReferences(engine, opts.id);
        console.log(
          JSON.stringify(
            ok
              ? { ok: true, id: opts.id }
              : {
                  ok: false,
                  error: "blocked-by-references",
                  id: opts.id,
                  referents,
                  hint: "move or remove the content, and revoke clients, tokens, enrollments and personal tokens that name this source",
                },
            null,
            2,
          ),
        );
        if (!ok) process.exitCode = 1;
        return;
      }
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memrain sources: unknown subcommand '${_exhaustive}'`);
      }
    }
  });
}

/** Helper used by cli.ts to validate --kind. */
export function isSourceKind(s: string): s is SourceKind {
  return (SOURCE_KINDS as readonly string[]).includes(s);
}

const VALID_SYNC_POLICIES: ReadonlySet<SyncPolicy> = new Set([
  "synced",
  "local-only",
  "mirror",
]);
const VALID_INDEXED_POLICIES: ReadonlySet<IndexedPolicy> = new Set([
  "verbatim",
  "hashed-only",
  "tombstoned",
]);

export function isSyncPolicy(s: string): s is SyncPolicy {
  return VALID_SYNC_POLICIES.has(s as SyncPolicy);
}

export function isIndexedPolicy(s: string): s is IndexedPolicy {
  return VALID_INDEXED_POLICIES.has(s as IndexedPolicy);
}

/**
 * `memrain sources owner-only <id> [on|off]`: marks a personal mailbox or
 * calendar source owner-only (core/owner-only.ts). It closes at once to every
 * remote key but the owner's, whether the brain serves one person or several.
 */
export async function runSourceOwnerOnly(id: string | undefined, value: string | undefined): Promise<number> {
  if (!id || (value !== undefined && value !== "on" && value !== "off")) {
    console.error("Usage: memrain sources owner-only <id> [on|off]");
    return 1;
  }
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    const engine = storage.engine();
    if (value === undefined) {
      const r = await engine.query<{ owner_only: boolean }>(`SELECT owner_only FROM sources WHERE id = $1`, [id]);
      if (!r.rows[0]) throw new Error(`unknown source "${id}"`);
      console.log(JSON.stringify({ ok: true, source_id: id, owner_only: r.rows[0].owner_only === true }, null, 2));
      return 0;
    }
    const set = await setSourceOwnerOnly(engine, id, value === "on");
    const pending = set.owner_only && !(await provenanceBackfilled(engine));
    console.log(JSON.stringify({
      ok: true, ...set,
      ...(pending ? { note: "Rows derived from this source before this release are not closed yet: run memrain sources provenance, then --apply." } : {}),
    }, null, 2));
    return 0;
  });
}

/**
 * `memrain sources federate <id>` / `unfederate <id>`: whether a read that
 * names no source, from a caller whose grant names none, reaches this source
 * (core/sources.ts federatedReadScope). Grants that list the source are not
 * touched.
 */
export async function runSourceFederate(id: string | undefined, federated: boolean): Promise<number> {
  if (!id) {
    console.error(`Usage: memrain sources ${federated ? "federate" : "unfederate"} <id>`);
    return 1;
  }
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    console.log(JSON.stringify({ ok: true, ...(await setSourceFederated(storage.engine(), id, federated)) }, null, 2));
    return 0;
  });
}

/**
 * `memrain sources provenance [--apply]`: records where derived rows written
 * before migration 181 came from. Dry run unless --apply; metadata only.
 */
export async function runSourceProvenance(apply: boolean): Promise<number> {
  const storage = new Storage(loadConfig());
  return withStorage(storage, async () => {
    console.log(JSON.stringify({ ok: true, ...(await provenanceBackfill(storage.engine(), { apply })) }, null, 2));
    return 0;
  });
}
