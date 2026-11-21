/**
 * Where a retired fact's validity ends when a replacement supersedes it: at the
 * replacement's start when that falls inside the retired window (after its
 * start, before its stored end or today); otherwise at its stored end or today,
 * whichever is earlier, so a backdated, undated or future-dated replacement
 * never leaves the retired fact open. An open fact never ends before its own
 * start, and a stored end is never moved later.
 */
export function supersededValidUntilSql(newDateParam: number): string {
  if (!Number.isSafeInteger(newDateParam) || newDateParam < 1) throw new Error("invalid date parameter");
  const date = `$${newDateParam}::date`;
  return `CASE WHEN ${date} > COALESCE(valid_from, '-infinity'::date)
                AND ${date} < COALESCE(valid_until, CURRENT_DATE)
               THEN ${date}
               WHEN valid_until IS NULL THEN GREATEST(CURRENT_DATE, valid_from)
               ELSE LEAST(valid_until, GREATEST(CURRENT_DATE, valid_from)) END`;
}
