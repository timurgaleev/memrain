import { isCalendarDate } from "./effective-date.ts";
import { OperationError } from "./operation-error.ts";

export interface LinkTemporalOptions {
  status?: "all" | "active" | "expired" | "future";
  asOf?: string;
}

export function linkDate(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDate(value)) throw new OperationError("invalid_params", "link validity requires a valid YYYY-MM-DD date");
  return value;
}

/** One bound date parameter is reused across every arm or graph expansion. */
export function linkValiditySql(alias: string, opts: LinkTemporalOptions, params: unknown[]): string {
  if (!/^[a-z_]\w*$/i.test(alias)) throw new Error("invalid link SQL alias");
  const status = opts.status ?? "all";
  if (!["all", "active", "expired", "future"].includes(status)) throw new OperationError("invalid_params", "invalid link status");
  if (status === "all") {
    if (opts.asOf !== undefined) throw new OperationError("invalid_params", "as_of requires active, expired or future status");
    return "";
  }
  const date = opts.asOf === undefined ? new Date().toISOString().slice(0, 10) : linkDate(opts.asOf);
  if (date === null) throw new OperationError("invalid_params", "as_of requires a date");
  params.push(date);
  const at = `$${params.length}::date`;
  if (status === "expired") return ` AND ${alias}.valid_until <= ${at}`;
  if (status === "future") return ` AND ${alias}.valid_from > ${at}`;
  return ` AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ${at}) AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${at})`;
}

export function linkValidityProjection(opts: LinkTemporalOptions): string {
  return opts.status === undefined ? "" : ", valid_from::text AS valid_from, valid_until::text AS valid_until";
}
