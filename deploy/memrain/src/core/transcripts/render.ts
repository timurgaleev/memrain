/**
 * Render a transcript session into `conversation` pages.
 *
 * Each turn is `[HH:MM] Speaker: text` (or `Speaker: text` when the source
 * has no time), the shape `parseConversation` reads. Every further line of a
 * message is indented by two spaces: no speaker pattern the parser knows
 * matches an indented line, so message text cannot open a turn of its own,
 * whatever it contains. The parser trims the indent back off.
 *
 * A session is packed into parts at message boundaries, each under the
 * embed-warn size so every part is embedded rather than stored as one
 * unsearchable blob. The last message of a part is repeated at the head of
 * the next so a thought that spans the boundary is retrievable from either.
 * Parts are packed from the start, so a session that grows only rewrites its
 * tail parts.
 */
import { createHash } from "node:crypto";
import type { TranscriptMessage, TranscriptSession } from "./types.ts";
import { neutralizeOutsideText } from "../neutralize-outside-text.ts";
import { OUTSIDE_NEUTRALIZED } from "../fence-carry.ts";

/**
 * Fact extraction reads a page body through a 12,000-character window, so a
 * part must fit inside it or everything past the window is never extracted.
 * Bytes bound characters from above; the slack covers the prompt sanitizer.
 */
export const PART_BUDGET_BYTES = 11_000;
const INDENT = "  ";
const TURN_SEPARATOR = "\n\n";
const TITLE_MAX = 200;
/** An overlap message larger than this share of a part is not repeated. */
const OVERLAP_MAX_SHARE = 4;

export interface RenderedPart {
  slug: string;
  /** 1-based. */
  index: number;
  title: string;
  body: string;
  truth: Record<string, unknown>;
  bytes: number;
}

interface Block {
  messageId: string;
  text: string;
  bytes: number;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function utcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function turnHeader(m: TranscriptMessage): string {
  if (m.ts === null) return `${m.speaker}: `;
  const d = new Date(m.ts);
  return `[${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}] ${m.speaker}: `;
}

/** Control characters (newlines included) would break the title onto a line
 *  of its own; collapse them and cap the length. */
export function cleanTitle(raw: string | null): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of raw ?? "") {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0) out += " ";
    pendingSpace = false;
    out += ch;
    if (out.length >= TITLE_MAX) break;
  }
  const t = out.trim();
  return t.length > 0 ? t : "Untitled conversation";
}

/**
 * A slug-safe form of the vendor id. Normalizing is lossy (case, punctuation,
 * length), so an id it changed carries a hash of the raw id: two ids that
 * normalize alike must not share parts. An id that is already slug-safe (the
 * lowercase UUIDs both vendors use) is kept as is, so its slugs never move.
 */
export function slugSafeId(id: string): string {
  const parts = id.toLowerCase().split(/[^a-z0-9]+/);
  const joined = parts.filter((p) => p.length > 0).join("-").slice(0, 120);
  const trimmed = joined.endsWith("-") ? joined.slice(0, -1) : joined;
  if (trimmed === id) return trimmed;
  const hash = createHash("sha256").update(id, "utf8").digest("hex");
  return trimmed.length > 0 ? `${trimmed}-h${hash.slice(0, 12)}` : `c${hash.slice(0, 16)}`;
}

export function sessionBaseSlug(session: TranscriptSession): string {
  return `transcripts/${session.format}/${slugSafeId(session.id)}`;
}

/** Split a string into pieces of at most `max` UTF-8 bytes, on code points. */
function sliceByBytes(line: string, max: number): string[] {
  const pieces: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    const b = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (curBytes + b > max && cur.length > 0) {
      pieces.push(cur.join(""));
      cur = [];
      curBytes = 0;
    }
    cur.push(ch);
    curBytes += b;
  }
  if (cur.length > 0 || pieces.length === 0) pieces.push(cur.join(""));
  return pieces;
}

/** Message text is outside text: it must not read as a fence, citation or timeline row. */
function textLines(text: string): string[] {
  return neutralizeOutsideText(text).split("\n");
}

/**
 * One turn: header plus the first line, then every other line indented. Blank
 * leading lines are dropped: the parser does not read a bare `Speaker:` line
 * as a turn, and a split piece of a long message can start on one.
 */
export function renderTurn(m: TranscriptMessage, lines: readonly string[] = textLines(m.text)): string {
  let start = 0;
  while (start < lines.length - 1 && lines[start]!.trim().length === 0) start++;
  const [first = "", ...rest] = lines.slice(start);
  const tail = rest.map((l) => (l.length > 0 ? INDENT + l : "")).join("\n");
  return rest.length > 0 ? `${turnHeader(m)}${first}\n${tail}` : `${turnHeader(m)}${first}`;
}

/**
 * A message as one or more blocks, each within `budget`. An oversized message
 * is cut at line boundaries (a single overlong line at byte boundaries), and
 * every piece carries the turn header so each part still parses on its own.
 */
function messageBlocks(m: TranscriptMessage, budget: number): Block[] {
  const whole = renderTurn(m);
  const wholeBytes = byteLen(whole);
  if (wholeBytes <= budget) return [{ messageId: m.id, text: whole, bytes: wholeBytes }];
  const headerBytes = byteLen(turnHeader(m));
  const room = Math.max(64, budget - headerBytes - INDENT.length - 1);
  const pieces: string[] = [];
  for (const line of textLines(m.text)) {
    if (byteLen(line) <= room) pieces.push(line);
    else pieces.push(...sliceByBytes(line, room));
  }
  const blocks: Block[] = [];
  let group: string[] = [];
  let groupBytes = headerBytes;
  const flush = () => {
    if (group.length === 0) return;
    const text = renderTurn(m, group);
    blocks.push({ messageId: m.id, text, bytes: byteLen(text) });
    group = [];
    groupBytes = headerBytes;
  };
  for (const p of pieces) {
    const cost = byteLen(p) + INDENT.length + 1;
    if (group.length > 0 && groupBytes + cost > budget) flush();
    group.push(p);
    groupBytes += cost;
  }
  flush();
  return blocks;
}

/** Pack blocks into parts at block boundaries, with one block of overlap. */
export function packBlocks<T extends { bytes: number }>(blocks: readonly T[], budget: number): T[][] {
  const sep = byteLen(TURN_SEPARATOR);
  const parts: T[][] = [];
  let cur: T[] = [];
  let curBytes = 0;
  for (const b of blocks) {
    if (cur.length > 0 && curBytes + sep + b.bytes > budget) {
      parts.push(cur);
      const last = cur[cur.length - 1]!;
      cur = [];
      curBytes = 0;
      if (last.bytes * OVERLAP_MAX_SHARE <= budget && last.bytes + sep + b.bytes <= budget) {
        cur.push(last);
        curBytes = last.bytes;
      }
    }
    curBytes += (cur.length > 0 ? sep : 0) + b.bytes;
    cur.push(b);
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** jsonb returns object keys ordered by length, then bytewise; writing them in
 *  that order keeps an unchanged re-put byte-identical, so it stays a no-op. */
function jsonbKeyOrder(obj: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(obj).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

export function renderSession(session: TranscriptSession, budget: number = PART_BUDGET_BYTES): RenderedPart[] {
  const base = sessionBaseSlug(session);
  const title = cleanTitle(session.title);
  const blocks = session.messages.flatMap((m) => messageBlocks(m, budget));
  return packBlocks(blocks, budget).map((part, i) => {
    const body = `${part.map((b) => b.text).join(TURN_SEPARATOR)}\n`;
    const truth: Record<string, unknown> = {
      conversation_id: session.id,
      format: session.format,
      part: i + 1,
      first_message_id: part[0]!.messageId,
      last_message_id: part[part.length - 1]!.messageId,
    };
    if (session.startedAt !== null) truth.date = utcDate(session.startedAt);
    truth[OUTSIDE_NEUTRALIZED] = 1;
    return {
      slug: `${base}-p${i + 1}`,
      index: i + 1,
      title: `${title} (part ${i + 1})`,
      body,
      truth: jsonbKeyOrder(truth),
      bytes: byteLen(body),
    };
  });
}
