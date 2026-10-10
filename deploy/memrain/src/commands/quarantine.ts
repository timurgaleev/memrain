/**
 * `memrain quarantine <list|clear|scan>` — operator surface for the
 * content-sanity gate (frontmatter markers stamped at ingest, see
 * core/content-sanity.ts). Until now releasing held content required SQL.
 *
 *   list  [--json] [--include-flagged]
 *         quarantined (hidden) documents; --include-flagged adds content_flag
 *         (searchable, warned) rows.
 *   clear <slug|source_path> [--force] [--json]
 *         drop the markers so the document is searchable again. The gate
 *         re-runs first: content still assessed as junk refuses to clear
 *         unless --force. The clear records a `quarantine_override` bound to
 *         the title and body, so re-indexing the same content (and `scan`)
 *         keeps it released; any edit expires it. Cleared docs re-enter the vector arm via
 *         `memrain embed` (their chunks were never embedded).
 *   scan  [--limit N] [--apply] [--json]
 *         re-assess already-indexed documents through the CURRENT gate
 *         thresholds — catches junk that predates the gate. Dry-run by
 *         default; --apply stamps the markers (and drops embeddings for
 *         newly-quarantined docs so the vector arm forgets them).
 */
import { Storage } from "../core/storage.ts";
import { withStorage } from "./with-storage.ts";
import { loadConfig } from "../core/config.ts";
import type { Engine } from "../core/engine/interface.ts";
import {
  assessContentSanity,
  stampSanityMarkers,
  resolveOperatorLiterals,
  resolveDisabledPatterns,
  resolveSanityThresholds,
} from "../core/content-sanity.ts";
import {
  QUARANTINE_OVERRIDE_KEY,
  auditQuarantine,
  quarantineOverrideBinding,
  withQuarantineOverride,
  type QuarantineOverride,
} from "../core/quarantine.ts";
import { bumpDocumentClock } from "../core/generation.ts";
import { clearCache } from "../core/search/query-cache.ts";

export type QuarantineSub = "list" | "clear" | "scan";

export interface QuarantineCmdOptions {
  sub: QuarantineSub;
  /** clear: slug or source_path. */
  target?: string;
  includeFlagged?: boolean;
  force?: boolean;
  apply?: boolean;
  limit?: number;
  json?: boolean;
  configPath?: string;
}

interface MarkedRow {
  id: string;
  source_path: string;
  source_id: string | null;
  marker: "quarantine" | "content_flag";
  reason: string;
  detail: string;
}

async function listMarked(engine: Engine, includeFlagged: boolean): Promise<MarkedRow[]> {
  const r = await engine.query<{
    id: string;
    source_path: string;
    source_id: string | null;
    frontmatter: Record<string, unknown> | null;
  }>(
    `SELECT id, source_path, source_id, frontmatter
       FROM documents
      WHERE frontmatter ? 'quarantine'${includeFlagged ? " OR frontmatter ? 'content_flag'" : ""}
      ORDER BY source_path`,
  );
  const rows: MarkedRow[] = [];
  for (const d of r.rows) {
    const fm = d.frontmatter ?? {};
    const q = fm["quarantine"] as { reason?: string; detail?: string } | undefined;
    const f = fm["content_flag"] as { reason?: string; detail?: string } | undefined;
    if (q) {
      rows.push({
        id: d.id,
        source_path: d.source_path,
        source_id: d.source_id,
        marker: "quarantine",
        reason: q.reason ?? "unknown",
        detail: q.detail ?? "",
      });
    } else if (f && includeFlagged) {
      rows.push({
        id: d.id,
        source_path: d.source_path,
        source_id: d.source_id,
        marker: "content_flag",
        reason: f.reason ?? "unknown",
        detail: f.detail ?? "",
      });
    }
  }
  return rows;
}

/**
 * Reassemble a document's body text from its stored prose chunks (index
 * order) — the same text the indexer's gate assessed and bound an override
 * to. Fenced-code symbol chunks are copies of code already in the prose.
 */
async function docBody(engine: Engine, docId: string): Promise<string> {
  const r = await engine.query<{ content: string }>(
    `SELECT content FROM chunks
      WHERE document_id = $1 AND chunk_source IS DISTINCT FROM 'fenced_code'
      ORDER BY chunk_index`,
    [docId],
  );
  return r.rows.map((c) => c.content).join("\n\n");
}

interface DocRow {
  id: string;
  source_path: string;
  source_id: string | null;
  title: string | null;
  frontmatter: Record<string, unknown> | null;
}

/** The title the indexer's gate assessed: the title column, else the header's. */
function docTitle(doc: DocRow): string {
  const fm = doc.frontmatter ?? {};
  return doc.title ?? (typeof fm["title"] === "string" ? (fm["title"] as string) : "");
}

/** The gate's verdict on a stored document, honouring a current operator override. */
function assessDoc(doc: DocRow, body: string) {
  const fm = doc.frontmatter ?? {};
  const title = docTitle(doc);
  const sanity = assessContentSanity({
    body,
    title,
    page_kind: fm["kind"] === "code" ? "code" : undefined,
    extra_literals: resolveOperatorLiterals(),
    disabled_patterns: resolveDisabledPatterns(),
    ...resolveSanityThresholds(),
  });
  return withQuarantineOverride(sanity, { title, body, frontmatter: fm });
}

async function runList(engine: Engine, opts: QuarantineCmdOptions): Promise<number> {
  const rows = await listMarked(engine, opts.includeFlagged ?? false);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(
      opts.includeFlagged
        ? "No quarantined or flagged documents."
        : "No quarantined documents. (--include-flagged also lists content_flag docs.)",
    );
    return 0;
  }
  for (const r of rows) {
    const src = r.source_id && r.source_id !== "default" ? ` [${r.source_id}]` : "";
    console.log(
      `  ${r.marker === "quarantine" ? "HIDDEN " : "FLAGGED"} ${r.source_path}${src}  reason=${r.reason}${r.detail ? `  (${r.detail})` : ""}`,
    );
  }
  const hidden = rows.filter((r) => r.marker === "quarantine").length;
  console.log(`\n${hidden} quarantined (hidden), ${rows.length - hidden} flagged (searchable, warned).`);
  return 0;
}

async function runClear(engine: Engine, opts: QuarantineCmdOptions): Promise<number> {
  if (!opts.target) {
    console.error("Usage: memrain quarantine clear <slug|source_path> [--force]");
    return 2;
  }
  // Accept the raw source_path or a page slug (its mirror forms).
  const r = await engine.query<DocRow>(
    `SELECT id, source_path, source_id, title, frontmatter
       FROM documents
      WHERE source_path = $1
         OR source_path = 'page://' || $1
         OR source_path = $1 || '.md'
      LIMIT 2`,
    [opts.target],
  );
  const doc = r.rows[0];
  if (!doc) {
    console.error(`No document found for "${opts.target}".`);
    return 2;
  }
  const fm = doc.frontmatter ?? {};
  if (!("quarantine" in fm) && !("content_flag" in fm) && !("embed_skip" in fm)) {
    console.log(`"${doc.source_path}" carries no sanity marker — nothing to clear.`);
    return 0;
  }

  // Re-run the gate on the stored content: junk that is STILL junk would just
  // re-quarantine on the next ingest, so refuse unless --force.
  const body = await docBody(engine, doc.id);
  if (!opts.force) {
    const sanity = assessDoc(doc, body);
    if (sanity.shouldQuarantine) {
      console.error(
        `"${doc.source_path}" is STILL assessed as junk (${[
          ...sanity.junk_pattern_matches,
          ...sanity.literal_substring_matches,
        ].join(", ")}). Fix the source content, or re-run with --force.`,
      );
      return 1;
    }
  }

  // The override is what makes the clear stick: the next index of this exact
  // title and body keeps the classifier verdict off instead of re-hiding it.
  const override: QuarantineOverride = {
    binding: quarantineOverrideBinding(docTitle(doc), body),
    cleared_at: new Date().toISOString(),
  };
  await engine.query(
    `UPDATE documents
        SET frontmatter = ((COALESCE(frontmatter, '{}'::jsonb) - 'quarantine') - 'content_flag' - 'embed_skip')
                          || jsonb_build_object('${QUARANTINE_OVERRIDE_KEY}', $2::text::jsonb)
      WHERE id = $1`,
    [doc.id, JSON.stringify(override)],
  );
  // Visibility flipped — cached rankings that excluded the doc are stale.
  await bumpDocumentClock(engine);
  await clearCache(engine);

  const out = {
    ok: true,
    cleared: doc.source_path,
    forced: opts.force ?? false,
    note: "Run `memrain embed` to give the released chunks vectors (they were embed-skipped).",
  };
  if (opts.json) console.log(JSON.stringify(out, null, 2));
  else console.log(`Cleared "${doc.source_path}". ${out.note}`);
  return 0;
}

async function runScan(engine: Engine, opts: QuarantineCmdOptions): Promise<number> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const r = await engine.query<DocRow>(
    `SELECT id, source_path, source_id, title, frontmatter
       FROM documents
      WHERE NOT (frontmatter ? 'quarantine')
        AND NOT (frontmatter ? 'content_flag')
        AND COALESCE(frontmatter->>'kind','') <> 'code'
      ORDER BY source_path`,
  );
  let scanned = 0;
  let quarantined = 0;
  let flagged = 0;
  const touched: Array<{ source_path: string; outcome: "quarantine" | "flag" }> = [];

  for (const doc of r.rows) {
    if (scanned >= limit) break;
    scanned++;
    const body = await docBody(engine, doc.id);
    if (body.trim().length === 0) continue;
    const sanity = assessDoc(doc, body);
    if (!sanity.shouldQuarantine && !sanity.shouldFlag && !sanity.shouldSkipEmbed) continue;

    if (sanity.shouldQuarantine) {
      quarantined++;
      touched.push({ source_path: doc.source_path, outcome: "quarantine" });
    } else {
      flagged++;
      touched.push({ source_path: doc.source_path, outcome: "flag" });
    }

    if (opts.apply) {
      const stamped = stampSanityMarkers(doc.frontmatter ?? {}, sanity);
      await engine.query(`UPDATE documents SET frontmatter = $2::jsonb WHERE id = $1`, [
        doc.id,
        stamped,
      ]);
      if (sanity.shouldQuarantine) {
        await auditQuarantine(engine, sanity, doc.source_path, doc.source_id);
        // A hidden doc must also leave the vector arm — junk vectors are
        // pure noise (and the chunks stay for a later `clear` to release).
        await engine.query(
          `DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = $1)`,
          [doc.id],
        );
      }
    }
  }

  if (opts.apply && touched.length > 0) {
    await bumpDocumentClock(engine);
    await clearCache(engine);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: true, applied: opts.apply ?? false, scanned, quarantined, flagged, touched },
        null,
        2,
      ),
    );
    return 0;
  }
  const verb = opts.apply ? "" : "(dry-run) would ";
  console.log(`Scanned ${scanned} document(s): ${verb}quarantine ${quarantined}, ${verb}flag ${flagged}.`);
  if (!opts.apply && touched.length > 0) console.log("Re-run with --apply to set the markers.");
  return 0;
}

export async function runQuarantine(opts: QuarantineCmdOptions): Promise<number> {
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    switch (opts.sub) {
      case "list":
        return await runList(engine, opts);
      case "clear":
        return await runClear(engine, opts);
      case "scan":
        return await runScan(engine, opts);
      default: {
        const _exhaustive: never = opts.sub;
        throw new Error(`memrain quarantine: unknown subcommand '${_exhaustive}'`);
      }
    }
  });
}
