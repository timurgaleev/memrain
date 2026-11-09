import { redactBody } from "../core/public_redaction.ts";
import type { Engine } from "../core/engine/interface.ts";
import { readQuarantineVerdicts } from "../core/quarantine.ts";

export function quarantineContent(row: Record<string, unknown>, withheld: boolean): Record<string, unknown> {
  if (!withheld) return row;
  const { markdown_body: _body, compiled_truth: _truth,
    body_snapshot: _snapshot, compiled_truth_snapshot: _snapshotTruth, change_reason: _reason, ...metadata } = row;
  return metadata;
}

export async function applyQuarantineVisibility<T extends { slug: string; source_id?: string | null }>(
  engine: Engine,
  rows: readonly T[],
  remote: boolean,
): Promise<Record<string, unknown>[]> {
  const verdicts = await readQuarantineVerdicts(engine, rows);
  return rows.map((row, i) => {
    const quarantined = verdicts[i];
    const withheld = remote && !!quarantined;
    return { ...quarantineContent(row as unknown as Record<string, unknown>, withheld),
      ...(quarantined ? { quarantined } : {}),
      ...(withheld ? { notice: "page_quarantined" } : {}) };
  });
}

export function redactQuarantinePage(row: Record<string, unknown>): Record<string, unknown> {
  return { ...redactBody(row),
    ...(row.quarantined ? { quarantined: row.quarantined } : {}),
    ...(row.notice === "page_quarantined" ? { notice: row.notice } : {}) };
}
