import type { Storage } from "../storage.ts";
import { normalizeChangeReason, putPage, VersionConflictError, validateSlug } from "../pages.ts";
import { OperationError } from "../operation-error.ts";
import { andSourceScope } from "../source-scope.ts";
import { takePageEligibleSql } from "./takes-owner.ts";
import { fenceTakeKey, storedTakeRowMax } from "./takes-canon.ts";
import { prepareTakeMutation, takeMutationSummary, type TakePageMutation } from "./takes-write-plan.ts";
import { validateTakeMutation, assertTakeMutationHolder } from "./takes-write.ts";

export interface RunTakeMutationInput extends TakePageMutation {
  slug: string;
  expectedVersion: number;
  writeSource?: string;
  dryRun?: boolean;
  reason?: string;
}
export async function runTakeMutation(storage: Storage, input: RunTakeMutationInput) {
  validateSlug(input.slug);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new OperationError("invalid_params", "expected_version must name an existing page version");
  if (input.planHash !== undefined && !/^[a-f0-9]{64}$/.test(input.planHash)) throw new OperationError("invalid_params", "plan_hash must be a SHA-256 hash");
  validateTakeMutation(input.mutation, input.actor);
  const reason = normalizeChangeReason(input.reason);
  if (input.dryRun) {
    const params: unknown[] = [input.slug];
    const scope = andSourceScope("p.source_id", input.sourceIds, params) +
      andSourceScope("p.source_id", input.writeSource === undefined ? undefined : [input.writeSource], params);
    const { rows } = await storage.engine().query<{ markdown_body: string; source_id: string; version_n: number }>(
      `SELECT p.markdown_body,p.source_id,(SELECT MAX(version_n) FROM page_versions v WHERE v.slug = p.slug) AS version_n
       FROM pages p WHERE p.slug = $1 AND ${takePageEligibleSql("p", input.excludeDiary)}${scope}`, params);
    const current = rows[0];
    if (!current) throw new OperationError("permission_denied", "Take page is outside the permitted scope");
    assertTakeMutationHolder(current.markdown_body, input.mutation, input.actor);
    if (current.version_n !== input.expectedVersion) throw new VersionConflictError(input.slug, current.version_n, input.expectedVersion);
    const storedMaxRow = await storedTakeRowMax(storage.engine(), input.slug);
    const prepared = prepareTakeMutation(current.markdown_body, input.slug, current.version_n, current.source_id, input, reason, input.writeSource, storedMaxRow);
    return { ok: true as const, dry_run: true, slug: input.slug, version_n: current.version_n,
      content_hash: prepared.after_hash, changed: prepared.body !== current.markdown_body,
      take_key: fenceTakeKey(input.slug, prepared.rowNum), ...takeMutationSummary(prepared) };
  }
  const result = await putPage(storage, { slug: input.slug, expectedVersion: input.expectedVersion, source_id: input.writeSource,
    written_by: `takes_${input.mutation.op}`, written_by_principal: input.actor.principal,
    change_reason: input.reason, takeMutation: input });
  if (!result.take_mutation) throw new OperationError("conflict", "Take mutation was not applied");
  return { ok: true as const, dry_run: false, slug: input.slug, version_n: result.version_n,
    content_hash: result.content_hash, changed: result.changed,
    take_key: fenceTakeKey(input.slug, result.take_mutation.row_num), ...result.take_mutation };
}
