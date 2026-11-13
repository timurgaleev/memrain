import { createHash } from "node:crypto";
import { guardEchoes, guardSecrets, secretDisposition, allowedFingerprints, switchedOn, SECRET_SCAN_VERSION, type SecretFinding } from "../secret-scan.ts";
import { OperationError } from "../operation-error.ts";
import { patchTakeFence, type TakeFenceMutation, type TakeMutationActor } from "./takes-write.ts";
import { parseRowCells, locateFenceMarkers } from "../fence-shared.ts";

export interface TakePageMutation {
  mutation: TakeFenceMutation;
  actor: TakeMutationActor;
  sourceIds?: string[];
  excludeDiary?: boolean;
  planHash?: string;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
function targetLine(body: string, rowNum: number): { start: number; end: number } | null {
  const span = locateFenceMarkers(body, "takes", true);
  if (!span || span.brand === "both") return null;
  let offset = span.beginIdx + span.begin.length;
  for (const line of body.slice(offset, span.endIdx).split("\n")) {
    const cells = parseRowCells(line);
    if (cells && /^\d+$/.test(cells[0] ?? "") && Number(cells[0]) === rowNum) return { start: offset, end: offset + line.length };
    offset += line.length + 1;
  }
  return null;
}
const withoutTarget = (body: string, rowNum: number): string => {
  const line = targetLine(body, rowNum);
  return line ? body.slice(0, line.start) + body.slice(line.end) : body;
};
const rowPreview = (body: string, rowNum: number): string | null => {
  const line = targetLine(body, rowNum);
  if (!line) return null;
  const safe = guardSecrets(body.slice(line.start, line.end), "take preview").text;
  return [...safe].slice(0, 2000).join("");
};
export function prepareTakeMutation(body: string, slug: string, version: number, owner: string,
  input: TakePageMutation, reason: string | null, writeSource: string | undefined, storedMaxRow: number) {
  const patch = patchTakeFence(body, input.mutation, input.actor, storedMaxRow);
  const findings: SecretFinding[] = [];
  const echo = new Map<string, string>();
  const scan = (text: string) => {
    const result = guardSecrets(text, `page '${slug}'`, { echo });
    findings.push(...result.findings);
    return result.text;
  };
  const guarded = guardEchoes({ body: scan(patch.body), reason: reason === null ? null : scan(reason) }, echo, findings);
  if (withoutTarget(patch.body, patch.rowNum) !== withoutTarget(guarded.body, patch.rowNum)) {
    throw new OperationError("conflict", "Secret scanning would change unrelated page content; repair the page before editing this take");
  }
  const planHash = hash(canonical({ slug, version, owner, before: hash(body), storedMaxRow, mutation: input.mutation, reason,
    principal: input.actor.principal, holders: input.actor.holderAllowList === undefined ? null : [...input.actor.holderAllowList].sort(),
    sources: input.sourceIds === undefined ? null : [...input.sourceIds].sort(), writeSource: writeSource ?? null,
    excludeDiary: input.excludeDiary === true,
    secretPolicy: { version: SECRET_SCAN_VERSION, disposition: secretDisposition(), allow: [...allowedFingerprints()].sort(),
      echo: switchedOn("MEMRAIN_SECRET_SCAN_ECHO"), highEntropy: switchedOn("MEMRAIN_SECRET_SCAN_HIGH_ENTROPY") } }));
  if (input.planHash !== undefined && input.planHash !== planHash) throw new OperationError("conflict", "Take mutation plan changed; preview again");
  return { ...patch, body: guarded.body, reason: guarded.reason, findings,
    changedRowNums: guarded.body === body ? [] : [patch.rowNum],
    plan_hash: planHash, before_hash: hash(body), after_hash: hash(guarded.body),
    row_diff: { before: rowPreview(body, patch.rowNum), after: rowPreview(guarded.body, patch.rowNum), max_code_points: 2000 },
  };
}
export type PreparedTakeMutation = ReturnType<typeof prepareTakeMutation>;
export function takeMutationSummary(prepared: PreparedTakeMutation) {
  return { row_num: prepared.rowNum, plan_hash: prepared.plan_hash, before_hash: prepared.before_hash,
    after_hash: prepared.after_hash, row_diff: prepared.row_diff, warnings: prepared.warnings };
}
