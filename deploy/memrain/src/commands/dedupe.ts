/**
 * `memrain dedupe` — duplicate person and company pages (core/entity-duplicates.ts).
 *
 *   memrain dedupe [--preview] [--json] [--source ID] [--kind person|company] [--id-field F,G]
 *       read-only: groups of pages that share a key, with a class and the key
 *       types that make the case (never their values)
 *   memrain dedupe reject <a> <b> [--source ID]
 *       record that the two pages are different; the pair is never proposed again
 *   memrain dedupe confirm <a> <b> --group ID [--source ID] [--id-field F,G]
 *       fold <a> into <b> with entity-merge (`memrain merge <a> <b>`), but only
 *       for a pair that shares a key directly, is not a conflict, was not
 *       rejected, and sits in the preview group named. The group id covers the
 *       declared id fields read, so confirm must pass the preview's --id-field:
 *       a veto from a custom id field cannot vanish between the two
 *
 * Nothing is merged without `confirm`. A trusted local CLI only: no MCP
 * operation reads the finder, since it walks every source it is given.
 */
import { loadConfig } from "../core/config.ts";
import { Storage } from "../core/storage.ts";
import { mergePage } from "../core/entity-merge.ts";
import {
  classifyGroup,
  entityPageOf,
  findDuplicateGroups,
  isRejectedPair,
  readRejections,
  recordRejection,
  scanEntityPages,
  type DuplicateEvidence,
  type DuplicateResult,
  type EntityKind,
  type EntityPage,
  type EntityScan,
  DEFAULT_ID_FIELDS,
} from "../core/entity-duplicates.ts";
import { withStorage } from "./with-storage.ts";

export interface DedupeOptions {
  sub: string;
  args: string[];
  json?: boolean;
  /** `--preview`: the default; refused next to reject or confirm. */
  preview?: boolean;
  sourceId?: string;
  kind?: string;
  idFields?: string;
  /** confirm: the preview group the pair was listed in. */
  group?: string;
  configPath?: string;
}

const USAGE = "usage: memrain dedupe [--preview] [--json] [--source ID] [--kind person|company] [--id-field F,G] | reject <a> <b> [--source ID] | confirm <a> <b> --group ID [--source ID] [--id-field F,G]";

function evidenceText(e: DuplicateEvidence): string {
  const parts: string[] = [e.rule.replace("_", " ")];
  if (e.key) parts.push(e.key === "declared_id" ? `id ${e.field}` : e.key);
  if (e.role_address) parts.push("(role address)");
  if (e.other_pages) parts.push(`(also on ${e.other_pages} other page(s))`);
  if (e.veto) parts.push("(veto: if they are one entity, correct the wrong id on one page)");
  return parts.join(" ");
}

export function renderPreview(result: DuplicateResult): string {
  const c = result.counts;
  const lines = [
    `${result.groups.length} group(s): ${c.by_class.clean} clean, ${c.by_class.likely} likely, ${c.by_class.conflict} conflict; ` +
      `${c.pages_scanned} page(s) read${c.truncated ? " (scan truncated)" : ""}, ${c.crowded_key_values} crowded key value(s) ignored`,
  ];
  for (const g of result.groups) {
    lines.push("", `${g.class.toUpperCase()}  ${g.kind}  ${g.source_id}: ${g.members.join("  ")}  (${g.id})`);
    for (const e of g.evidence) lines.push(`    ${evidenceText(e)}`);
  }
  if (result.groups.length) {
    const extra = result.id_fields.filter((f) => !DEFAULT_ID_FIELDS.includes(f));
    const flags = extra.length ? ` --id-field ${extra.join(",")}` : "";
    lines.push("", `Nothing was changed. memrain dedupe confirm <a> <b> --group <id>${flags} folds a into b; memrain dedupe reject <a> <b> keeps them apart.`);
  }
  return lines.join("\n");
}

function parseKind(kind: string | undefined): EntityKind | undefined {
  if (kind === undefined) return undefined;
  if (kind === "person" || kind === "company") return kind;
  throw new Error(`memrain dedupe: --kind must be person or company, got ${kind}`);
}

export async function runDedupe(opts: DedupeOptions): Promise<number> {
  const kind = parseKind(opts.kind);
  const idFields = (opts.idFields ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const storage = new Storage(loadConfig(opts.configPath));
  return withStorage(storage, async () => {
    const engine = storage.engine();
    const sub = opts.sub === "" || opts.sub === "preview" ? "preview" : opts.sub;
    if (sub === "preview") {
      if (opts.args.length) {
        console.error(USAGE);
        return 1;
      }
      const sourceIds = opts.sourceId ? [opts.sourceId] : undefined;
      const scan = await scanEntityPages(engine, { ...(sourceIds ? { sourceIds } : {}), idFields });
      const result = findDuplicateGroups(scan, await readRejections(engine, sourceIds), kind ? { kind } : {});
      console.log(opts.json ? JSON.stringify(result, null, 2) : renderPreview(result));
      return 0;
    }
    if ((sub !== "reject" && sub !== "confirm") || opts.preview) {
      console.error(USAGE);
      return 1;
    }
    const [a, b] = opts.args;
    if (!a || !b || opts.args.length !== 2 || a === b) {
      console.error(`memrain dedupe ${sub}: two different page slugs are required`);
      return 1;
    }
    const sourceId = opts.sourceId ?? "default";
    const outcome = sub === "reject"
      ? await rejectDuplicatePair(storage, sourceId, a, b, idFields)
      : await confirmDuplicatePair(storage, sourceId, a, b, idFields, opts.group ?? "");
    if (!outcome.ok) {
      console.error(`memrain dedupe ${sub}: ${outcome.error}`);
      for (const e of outcome.evidence ?? []) console.error(`    ${evidenceText(e)}`);
      return 1;
    }
    if (sub === "reject") {
      console.log(opts.json ? JSON.stringify({ ok: true, rejected: [a, b], source_id: sourceId })
        : `Recorded: ${a} and ${b} are different. The pair will not be proposed again.`);
    } else {
      console.log(JSON.stringify(outcome.result, null, 2));
    }
    return 0;
  });
}

export type PairOutcome =
  | { ok: true; result?: Record<string, unknown> }
  | { ok: false; error: string; evidence?: DuplicateEvidence[] };

type PairPages = { error: string } | { scan: EntityScan; pa: EntityPage; pb: EntityPage };

async function pairPages(storage: Storage, sourceId: string, a: string, b: string, idFields: string[]): Promise<PairPages> {
  const scan = await scanEntityPages(storage.engine(), { sourceIds: [sourceId], idFields });
  const pa = entityPageOf(scan, sourceId, a);
  const pb = entityPageOf(scan, sourceId, b);
  if (!pa || !pb) return { error: `${!pa ? a : b} is not a live person or company page in source ${sourceId}` };
  if (pa.kind !== pb.kind) return { error: `${a} is a ${pa.kind} and ${b} is a ${pb.kind}` };
  return { scan, pa, pb };
}

/** Record that two pages of one source are different entities. */
export async function rejectDuplicatePair(storage: Storage, sourceId: string, a: string, b: string, idFields: string[] = []): Promise<PairOutcome> {
  if (a === b) return { ok: false, error: "two different page slugs are required" };
  const pair = await pairPages(storage, sourceId, a, b, idFields);
  if ("error" in pair) return { ok: false, error: pair.error };
  await recordRejection(storage.engine(), pair.pa, pair.pb, "operator");
  return { ok: true };
}

/**
 * Fold `a` into `b` with entity-merge, only for a pair that shares a key
 * directly, is not a conflict and was not recorded as different.
 */
export async function confirmDuplicatePair(storage: Storage, sourceId: string, a: string, b: string, idFields: string[], groupId: string): Promise<PairOutcome> {
  if (a === b) return { ok: false, error: "two different page slugs are required" };
  if (!groupId) return { ok: false, error: "--group <id> is required: the id of the preview group that lists both pages" };
  const pair = await pairPages(storage, sourceId, a, b, idFields);
  if ("error" in pair) return { ok: false, error: pair.error };
  const rejections = await readRejections(storage.engine(), [sourceId]);
  if (isRejectedPair(rejections, pair.pa, pair.pb)) {
    return { ok: false, error: `${a} and ${b} were recorded as different; nothing merged (memrain merge folds them regardless)` };
  }
  const group = findDuplicateGroups(pair.scan, rejections).groups.find((g) => g.id === groupId);
  if (!group || !group.members.includes(a) || !group.members.includes(b)) {
    return { ok: false, error: `no current preview group ${groupId} lists both pages with these id fields; run a fresh preview and confirm with the same --id-field; nothing merged` };
  }
  const verdict = classifyGroup([pair.pa, pair.pb], pair.scan.carriers);
  if (verdict.shared === 0 || verdict.cls === "conflict") {
    return { ok: false, error: `${a} and ${b} ${verdict.shared === 0 ? "share no key" : "are a conflict"}; nothing merged`, evidence: verdict.evidence };
  }
  const merged = await mergePage(storage, a, b, { source_id: sourceId, written_by: "dedupe-confirm" });
  if (!merged.merged) return { ok: false, error: merged.reason ?? "merge refused" };
  return { ok: true, result: { ok: true, class: verdict.cls, evidence: verdict.evidence, ...merged } };
}
