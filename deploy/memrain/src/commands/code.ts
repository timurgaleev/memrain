/**
 * `memrain code-{def,refs,callers,callees}` — call-graph queries against
 * the entity_mentions table. All four subcommands translate to a SQL
 * filter on `entity_id` (which is `ent_<type>_<lower-name>` per
 * `core/entities.ts entityId()`).
 *
 * Output:
 *   - human: one row per mention, "<file>:<line>:<enclosing>"
 *   - --json: { ok, count, query: { type, name }, mentions: [...] }
 *
 * The `code-callees` query is two-phase:
 *   1. Resolve which symbol covers (file=X, line=Y) — a SQL hit on
 *      `chunks.start_line/end_line` (composite index from migration 014).
 *      That symbol's bare name becomes the lookup key for code-callee.
 *   2. SELECT entity_mentions for code-callee_<that-name>.
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import { entityId } from "../core/entities.ts";
import { codeIndexReadiness, type CodeReadinessGraph } from "../core/code-graph.ts";
import type { Engine } from "../core/engine/interface.ts";
import { visibilityClause } from "../core/visibility.ts";

export type CodeSub = "code-def" | "code-refs" | "code-callers" | "code-callees";

export interface CodeCommandOptions {
  sub: CodeSub;
  /** For code-{def,refs,callers}: the symbol name. */
  name?: string;
  /** For code-callees: the file:line target. */
  target?: string;
  json?: boolean;
}

interface MentionRow {
  surface_form: string;
  chunk_id: string;
  document_id: string;
  source_path: string;
}

const ENTITY_TYPE_FOR_SUB: Record<CodeSub, Exclude<CodeReadinessGraph, "edges">> = {
  "code-def": "code-def",
  "code-refs": "code-ref",
  "code-callers": "code-caller",
  "code-callees": "code-callee",
};

function parsePathLine(target: string): { file: string; line: number } | null {
  // Accept "<path>:<line>" — line is the LAST numeric segment so paths
  // containing a colon (rare; Windows-only) wouldn't poison this.
  const lastColon = target.lastIndexOf(":");
  if (lastColon < 0) return null;
  const file = target.slice(0, lastColon);
  const lineStr = target.slice(lastColon + 1);
  const line = Number(lineStr);
  if (!Number.isInteger(line) || line < 1) return null;
  if (file.length === 0) return null;
  return { file, line };
}

// stderr, so `--json` and piped stdout stay exactly as they were.
async function printReadiness(engine: Engine, graph: CodeReadinessGraph): Promise<void> {
  const r = await codeIndexReadiness(engine, undefined, graph);
  console.error(
    `no results — code index: ${r.state} (${r.code_documents} code documents, ${r.symbols} symbols)`,
  );
}

export async function runCode(opts: CodeCommandOptions): Promise<void> {
  const config = loadConfig();
  const storage = new Storage(config);
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const entityType = ENTITY_TYPE_FOR_SUB[opts.sub];

    let lookupName: string | null = opts.name ?? null;

    if (opts.sub === "code-callees") {
      if (!opts.target) {
        throw new Error(
          "memrain code-callees: <path>:<line> target is required",
        );
      }
      const parsed = parsePathLine(opts.target);
      if (!parsed) {
        throw new Error(
          `memrain code-callees: invalid target '${opts.target}' — expected '<path>:<line>'`,
        );
      }
      // Resolve the innermost-enclosing symbol for the file:line. We
      // strictly join through the code-def entity so a chunk that also
      // carries code-ref / code-caller entries doesn't shadow the def.
      // ORDER BY end_line - start_line ASC picks the smallest covering
      // range when multiple chunks overlap (innermost wins).
      const r = await engine.query<{ name: string }>(
        `SELECT e.name
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         JOIN entity_mentions em ON em.chunk_id = c.id
         JOIN entities e ON e.id = em.entity_id
         WHERE d.source_path = $1
           AND $2 BETWEEN c.start_line AND c.end_line
           AND e.type = 'code-def'
           AND ${visibilityClause("d")}
         ORDER BY (c.end_line - c.start_line) ASC
         LIMIT 1`,
        [parsed.file, parsed.line],
      );
      const sym = r.rows[0]?.name;
      if (!sym) {
        const msg = `no code symbol covers ${parsed.file}:${parsed.line}`;
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
          console.error(msg);
        }
        await printReadiness(engine, "code-def");
        process.exitCode = 1;
        return;
      }
      lookupName = sym;
    }

    if (!lookupName) {
      throw new Error(`memrain ${opts.sub}: <name> is required`);
    }

    const eid = entityId(entityType, lookupName);
    const r = await engine.query<MentionRow>(
      `SELECT em.surface_form, em.chunk_id, c.document_id, d.source_path
       FROM entity_mentions em
       JOIN chunks c ON c.id = em.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE em.entity_id = $1 AND ${visibilityClause("d")}
       ORDER BY d.source_path, c.start_line NULLS FIRST`,
      [eid],
    );

    if (r.rows.length === 0) await printReadiness(engine, entityType);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            count: r.rows.length,
            query: { type: entityType, name: lookupName },
            mentions: r.rows,
          },
          null,
          2,
        ),
      );
    } else {
      if (r.rows.length === 0) {
        console.log(`no mentions for ${entityType} '${lookupName}'`);
        process.exitCode = 1;
        return;
      }
      for (const row of r.rows) {
        console.log(row.surface_form);
      }
    }
  });
}
