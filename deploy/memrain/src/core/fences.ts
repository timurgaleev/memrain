/**
 * The facts and takes fences a 2.x brain wrote into page bodies. Their tables
 * are kept out of the search mirror, so neither is indexed as body text: the
 * takes text in particular must not become readable to every read scope.
 */
import { FENCE_BRANDS, fenceMarkers } from "./fence-shared.ts";

/**
 * Remove the `## Facts` fence block (markers + table, and the immediately
 * preceding `## Facts` heading if present) from a markdown body — so the
 * fenced table is not re-indexed as ordinary body text by the chunker. Leaves
 * the rest of the document untouched; a body with no fence is returned as-is.
 * Every brand present is stripped.
 */
export function stripFactsFence(markdown: string): string {
  let out = markdown;
  for (const brand of FENCE_BRANDS) out = stripOneFactsFence(out, fenceMarkers("facts", brand));
  return out;
}

function stripOneFactsFence(markdown: string, markers: { begin: string; end: string }): string {
  if (!markdown.includes(markers.begin)) return markdown;
  const lines = markdown.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === markers.begin);
  const end = lines.findIndex((l) => l.trim() === markers.end);
  if (begin === -1 || end === -1 || end <= begin) return markdown;

  // Also drop a `## Facts` heading directly above the fence (and one blank
  // line between them), so stripping doesn't leave a dangling header.
  let from = begin;
  let probe = begin - 1;
  while (probe >= 0 && (lines[probe] ?? "").trim() === "") probe--;
  if (probe >= 0 && /^#{1,6}\s+facts\s*$/i.test((lines[probe] ?? "").trim())) {
    from = probe;
  }
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  return kept.join("\n");
}

/**
 * Strip the fenced takes block from a body — used so takes content lives only
 * in the takes table, not duplicated into page chunks. No-op when no fence is
 * present or the input is not a string. Every brand present is stripped.
 */
export function stripTakesFence(body: string): string {
  if (typeof body !== "string") return body;
  let out = body;
  for (const brand of FENCE_BRANDS) out = stripOneTakesFence(out, fenceMarkers("takes", brand));
  return out;
}

function stripOneTakesFence(body: string, markers: { begin: string; end: string }): string {
  if (!body.includes(markers.begin)) return body;
  const lines = body.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === markers.begin);
  const end = lines.findIndex((l) => l.trim() === markers.end);
  if (begin === -1 || end === -1 || end <= begin) return body;

  // Also drop a `## Takes` heading directly above the fence (and any blank lines
  // between them), so stripping doesn't leave a dangling header that chunks as
  // search noise — mirrors stripFactsFence.
  let from = begin;
  let probe = begin - 1;
  while (probe >= 0 && (lines[probe] ?? "").trim() === "") probe--;
  if (probe >= 0 && /^#{1,6}\s+takes\s*$/i.test((lines[probe] ?? "").trim())) {
    from = probe;
  }
  const kept = [...lines.slice(0, from), ...lines.slice(end + 1)];
  return kept.join("\n");
}
