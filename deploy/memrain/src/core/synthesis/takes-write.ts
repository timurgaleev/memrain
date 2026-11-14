import { isCalendarDate } from "../effective-date.ts";
import { escapeFenceCell, fenceMarkers, locateFenceMarkers, parseRowCells, isSeparatorRow } from "../fence-shared.ts";
import { OperationError } from "../operation-error.ts";
import { isValidHolder, parseTakesFence, type TakeQuality } from "./takes-fence.ts";

type TakeFields = { claim: string; kind: string; weight?: number; since?: string; until?: string; source?: string };
export type TakeFenceMutation =
  | ({ op: "add"; holder: string } & TakeFields)
  | ({ op: "update"; rowNum: number; active?: boolean } & Partial<TakeFields>)
  | { op: "resolve"; rowNum: number; quality: TakeQuality; evidence?: string; value?: number; unit?: string };
export interface TakeMutationActor {
  principal: string;
  holderAllowList?: readonly string[];
  resolvedAt?: string;
}
export interface TakeFencePatch {
  body: string;
  rowNum: number;
  changedRowNums: number[];
  warnings: string[];
}
const BASE = ["#", "claim", "kind", "who", "weight", "since", "source"];
const RESOLUTION = ["resolved", "quality", "evidence", "value", "unit", "by"];
const KINDS = new Set(["fact", "take", "bet", "hunch", "prediction", "judgment"]);
const QUALITIES = new Set(["correct", "incorrect", "partial", "unresolvable"]);
const MAX_ROW = 2_147_483_647;

function invalid(message: string): never {
  throw new OperationError("invalid_params", `takes: ${message}`);
}
function textCell(value: unknown, label: string, required = false, limit = 4000): asserts value is string {
  if (typeof value !== "string" || (required && !value.trim()) || [...value].length > limit ||
      /[\r\n\u2028\u2029\0]/u.test(value) || /[\uD800-\uDFFF]/u.test(value) ||
      /<!--[-\s]*(?:memrain|memex):/i.test(value)) invalid(`${label} must be bounded single-line text without fence markers`);
}
function dateCell(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarDate(value)) {
    invalid(`${label} must be a valid YYYY-MM-DD date`);
  }
}
function assertHolder(holder: string, actor: TakeMutationActor): void {
  if (!isValidHolder(holder) || (actor.holderAllowList !== undefined &&
      !actor.holderAllowList.includes("*") && !actor.holderAllowList.includes(holder))) {
    throw new OperationError("permission_denied", "Take holder is outside the permitted scope");
  }
}
export function validateTakeMutation(mutation: TakeFenceMutation, actor: TakeMutationActor): void {
  if (!mutation || typeof mutation !== "object") invalid("mutation is required");
  textCell(actor.principal, "principal", true, 4000);
  const allowed = mutation.op === "add" ? ["op", "claim", "kind", "holder", "weight", "since", "until", "source"]
    : mutation.op === "update" ? ["op", "rowNum", "claim", "kind", "weight", "since", "until", "source", "active"]
    : mutation.op === "resolve" ? ["op", "rowNum", "quality", "evidence", "value", "unit"] : [];
  if (!allowed.length || Object.keys(mutation).some((key) => !allowed.includes(key))) invalid("unknown mutation field");
  if (mutation.op !== "add" && (!Number.isInteger(mutation.rowNum) || mutation.rowNum < 1 || mutation.rowNum > MAX_ROW)) invalid("rowNum must be a positive integer");
  if (mutation.op === "resolve") {
    if (!QUALITIES.has(mutation.quality)) invalid("unknown resolution quality");
    if (mutation.value !== undefined && (typeof mutation.value !== "number" || !Number.isFinite(mutation.value))) invalid("value must be finite");
    for (const key of ["evidence", "unit"] as const) if (mutation[key] !== undefined) textCell(mutation[key], key);
    if (actor.resolvedAt !== undefined && !Number.isFinite(Date.parse(actor.resolvedAt))) invalid("invalid resolution time");
    return;
  }
  if (mutation.op === "add" || mutation.claim !== undefined) {
    textCell(mutation.claim, "claim", true);
    if (/^~~.*~~$/.test(mutation.claim!)) invalid("use active to retract a claim");
  }
  if ((mutation.op === "add" || mutation.kind !== undefined) && !KINDS.has(mutation.kind!)) invalid("unknown kind");
  if (mutation.weight !== undefined && (typeof mutation.weight !== "number" || !Number.isFinite(mutation.weight) || mutation.weight < 0 || mutation.weight > 1)) invalid("weight must be between 0 and 1");
  for (const key of ["since", "until"] as const) if (mutation[key] !== undefined) dateCell(mutation[key], key);
  if (mutation.source !== undefined) textCell(mutation.source, "source");
  if (mutation.op === "add") assertHolder(mutation.holder, actor);
  if (mutation.op === "update") {
    if (mutation.active !== undefined && typeof mutation.active !== "boolean") invalid("active must be boolean");
    if (!Object.entries(mutation).some(([k, v]) => k !== "op" && k !== "rowNum" && v !== undefined)) invalid("update requires a changed field");
  }
}

export function assertTakeMutationHolder(body: string, mutation: TakeFenceMutation, actor: TakeMutationActor): void {
  validateTakeMutation(mutation, actor);
  if (mutation.op === "add") return;
  const target = parseTakesFence(body).takes.find((take) => take.rowNum === mutation.rowNum);
  if (!target) throw new OperationError("permission_denied", "Take row is outside the permitted scope");
  assertHolder(target.holder, actor);
}

interface Line { text: string; ending: string }
const render = (cells: readonly string[]) => `| ${cells.map(escapeFenceCell).join(" | ")} |`;
function rowId(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    if (/^[+\-.\d]/.test(value)) invalid("ambiguous numeric row identifier");
    return undefined;
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ROW) invalid("invalid numeric row identifier");
  return id;
}
function assertOneFence(body: string): ReturnType<typeof locateFenceMarkers> {
  const span = locateFenceMarkers(body, "takes", true);
  if (span?.brand === "both") invalid("mixed takes fences");
  if (span === null) return null;
  if (span.beginIdx < 0 || span.endIdx < span.beginIdx) invalid("unbalanced takes fence");
  // Mask the first markers, then let the code-aware locator detect duplicates.
  const masked = body.slice(0, span.beginIdx) + " ".repeat(span.begin.length) +
    body.slice(span.beginIdx + span.begin.length, span.endIdx) + " ".repeat(span.end.length) + body.slice(span.endIdx + span.end.length);
  if (locateFenceMarkers(masked, "takes", true) !== null) invalid("multiple takes fences");
  return span;
}

/**
 * `storedMaxRow` is the highest row number the brain already holds for the
 * page. A page rewritten without its takes fence still has those rows, and
 * numbering from the fence alone would reuse #1 and overwrite the stored take.
 */
export function patchTakeFence(body: string, mutation: TakeFenceMutation, actor: TakeMutationActor, storedMaxRow = 0): TakeFencePatch {
  validateTakeMutation(mutation, actor);
  const span = assertOneFence(body);
  if (span === null) {
    if (mutation.op !== "add") invalid("takes fence not found");
    const markers = fenceMarkers("takes", "memrain");
    const separator = body.length > 0 && !body.endsWith("\n") ? "\n\n" : "\n";
    return patchTakeFence(`${body}${separator}${markers.begin}\n${render(BASE)}\n${render(BASE.map(() => "---"))}\n${markers.end}\n`, mutation, actor, storedMaxRow);
  }
  if (span.brand === "both") invalid("mixed takes fences");
  const innerStart = span.beginIdx + span.begin.length;
  const innerEnd = body.lastIndexOf("\n", span.endIdx - 1) + 1;
  const inner = body.slice(innerStart, innerEnd);
  const pieces = inner.split(/(\r\n|\n|\r)/);
  const lines: Line[] = pieces.filter((_part, i) => i % 2 === 0).map((part, i) => ({ text: part, ending: pieces[i * 2 + 1] ?? "" }));
  const tables = lines.map((line, index) => ({ index, cells: parseRowCells(line.text) })).filter((entry) => entry.cells !== null);
  const first = tables[0];
  if (!first || BASE.some((name, i) => first.cells![i]?.toLowerCase() !== name)) invalid("unknown takes header schema");
  const header = first.cells!;
  const lower = header.map((cell) => cell.toLowerCase());
  if (new Set(lower).size !== lower.length) invalid("duplicate header columns");
  const separator = tables[1];
  if (!separator || !isSeparatorRow(separator.cells!) || separator.cells!.length !== header.length) invalid("invalid takes header separator");
  const ids = new Map<number, { index: number; cells: string[] }>();
  for (const entry of tables.slice(2)) {
    if (isSeparatorRow(entry.cells!) || entry.cells![0] === "#") invalid("ambiguous additional table header");
    const id = rowId(entry.cells![0] ?? "");
    if (id === undefined) continue;
    if (ids.has(id)) invalid("duplicate numeric row identifier");
    ids.set(id, { index: entry.index, cells: entry.cells! });
  }
  const rowNum = mutation.op === "add" ? [...ids.keys()].reduce((max, id) => Math.max(max, id), storedMaxRow) + 1 : mutation.rowNum;
  if (rowNum > MAX_ROW) invalid("row number limit reached");
  const parsed = parseTakesFence(body);
  const existing = parsed.takes.find((take) => take.rowNum === rowNum);
  const target = ids.get(rowNum);
  if (mutation.op !== "add" && (!target || !existing || target.cells.length < 7)) invalid("target row is missing or malformed");
  if (existing) assertHolder(existing.holder, actor);
  let cells = target ? [...target.cells] : Array.from<string>({ length: header.length }).fill("");
  const nextHeader = [...header];
  if (mutation.op === "resolve") {
    if (!existing!.active) invalid("cannot resolve an inactive take");
    for (const name of RESOLUTION) if (!lower.includes(name)) nextHeader.push(name);
    cells = Array.from({ length: Math.max(cells.length, nextHeader.length) }, (_, i) => cells[i] ?? "");
    const values = [actor.resolvedAt ?? new Date().toISOString(), mutation.quality, mutation.evidence ?? "",
      mutation.value === undefined ? "" : String(mutation.value), mutation.unit ?? "", actor.principal];
    for (const [i, name] of RESOLUTION.entries()) cells[nextHeader.map((c) => c.toLowerCase()).indexOf(name)] = values[i]!;
  } else {
    const since = mutation.since ?? existing?.sinceDate;
    const until = mutation.until ?? existing?.untilDate;
    if (until && !since) invalid("until requires since");
    if (since && until && since > until) invalid("until precedes since");
    cells[0] = String(rowNum);
    const active = mutation.op === "add" ? true : mutation.active ?? existing!.active;
    const claim = mutation.claim?.trim() ?? existing!.claim;
    cells[1] = active ? claim : `~~${claim}~~`;
    cells[2] = mutation.kind ?? existing!.kind;
    cells[3] = mutation.op === "add" ? mutation.holder : existing!.holder;
    cells[4] = mutation.weight === undefined ? (target?.cells[4] ?? "0.5") : String(mutation.weight);
    if (mutation.since !== undefined || mutation.until !== undefined || mutation.op === "add") cells[5] = since ? `${since}${until ? ` → ${until}` : ""}` : "";
    cells[6] = mutation.source ?? target?.cells[6] ?? "";
    if (mutation.op === "update" && mutation.claim !== undefined && mutation.claim.trim() !== existing!.claim) {
      for (const name of RESOLUTION) {
        const i = lower.indexOf(name);
        if (i >= 0 && i < cells.length) cells[i] = "";
      }
    }
  }
  const eol = lines.find((line) => line.ending)?.ending ?? "\n";
  const replacements = new Map<number, string>();
  if (nextHeader.length !== header.length) {
    replacements.set(first.index, render(nextHeader));
    replacements.set(separator.index, render([...separator.cells!, ...nextHeader.slice(header.length).map(() => "---")]));
  }
  if (target && (cells.length !== target.cells.length || cells.some((cell, i) => cell !== target.cells[i]))) replacements.set(target.index, render(cells));
  let nextInner = lines.map((line, i) => (replacements.get(i) ?? line.text) + line.ending).join("");
  if (!target) nextInner += `${render(cells)}${eol}`;
  const nextBody = body.slice(0, innerStart) + nextInner + body.slice(innerEnd);
  const warnings = [...new Set(parsed.warnings.map((warning) => warning.split(":")[0]!))].slice(0, 20);
  return { body: nextBody, rowNum, changedRowNums: nextBody === body ? [] : [rowNum], warnings };
}
