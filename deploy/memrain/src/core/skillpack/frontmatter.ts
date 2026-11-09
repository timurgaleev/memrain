/**
 * skillpack/frontmatter.ts — the one parser for a pack skill's frontmatter.
 *
 * The listing, `get_skill`, `skillify check` and the pack lint all read the
 * same contract (`name`, `description`, `triggers`, `tools`, `mutating`,
 * `requires`, `writes_to`), so they share this parser instead of each keeping
 * its own regex. It reads the YAML subset the pack actually uses — top-level
 * scalars, `|`/`>` block scalars, `- item` lists and `[a, b]` inline lists —
 * line by line with indexOf, so a hostile skill file cannot make it backtrack.
 */

/** Keys the pack contract defines; anything else lands in `unknownKeys`. */
export const SKILL_CONTRACT_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "triggers",
  "tools",
  "mutating",
  "requires",
  "writes_to",
  "prompt",
]);

export interface SkillFrontmatter {
  name: string | null;
  description: string | null;
  triggers: string[];
  tools: string[];
  mutating: boolean | null;
  requires: string[];
  writes_to: string[];
  /** Top-level keys outside the contract, in file order (e.g. `version`). */
  unknownKeys: string[];
  /** Every top-level scalar value, quote-stripped (legacy `title` lives here). */
  scalars: Record<string, string>;
  /** Every top-level list value (legacy `tags` lives here). */
  lists: Record<string, string[]>;
  /** 1-based file line of each top-level key. */
  keyLines: Record<string, number>;
  /** Markdown after the closing fence. */
  body: string;
  /** 1-based file line the body starts on. */
  bodyLine: number;
}

// The opener's trailing run excludes `\n` on purpose. With `\s*` it and the
// lazy body could trade newlines: on a skill file of `---` + `\n`*n + `x`
// every split of the run re-scans the whole body for a closing fence that is
// not there — measured through listBrainSkillpacks at 9 ms for 6 K newlines,
// 611 ms for 50 K, ratio 4.0 on a doubling. `[^\S\n]*` still eats the spaces,
// tabs and CR that may pad the `---` line, but leaves exactly one way to
// match, so the body is scanned once: 1 ms at 2 M newlines, ratio 2.0.
const FENCE_RE = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n/;

const BLOCK_SCALAR_MARKERS = new Set(["|", ">", "|-", ">-", "|+", ">+"]);

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function isKey(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 64) return false;
  return /^[A-Z_][\w-]*$/i.test(candidate);
}

function isIndented(line: string): boolean {
  return line.length > 0 && (line[0] === " " || line[0] === "\t");
}

function parseInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((t) => unquote(t.trim()))
    .filter((t) => t.length > 0);
}

/**
 * Parse a skill file's frontmatter. Returns null when the file does not open
 * with a `---` fenced block. Never throws: a malformed key is skipped, not
 * fatal, so one bad skill cannot take the listing down.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  const block = m[1] ?? "";
  const body = text.slice(m[0].length);
  let bodyLine = 1;
  for (let i = m[0].indexOf("\n"); i !== -1; i = m[0].indexOf("\n", i + 1)) bodyLine++;

  const lines = block.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const keyLines: Record<string, number> = {};
  const unknownKeys: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length === 0 || isIndented(line) || line[0] === "#") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    if (!isKey(key) || key in keyLines) continue;
    // +1 for the opening fence line, +1 for 1-based numbering.
    keyLines[key] = i + 2;
    if (!SKILL_CONTRACT_KEYS.has(key)) unknownKeys.push(key);
    const value = unquote(line.slice(colon + 1).trim());

    if (BLOCK_SCALAR_MARKERS.has(value)) {
      // The text lives on the following more-indented lines; the pack only
      // uses these for prose, so they are joined into one line.
      const parts: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim().length === 0) {
          if (parts.length > 0) break;
          continue;
        }
        if (!isIndented(l)) break;
        parts.push(l.trim());
      }
      scalars[key] = parts.join(" ").trim();
      i = j - 1;
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      lists[key] = parseInlineList(value);
      continue;
    }

    if (value.length === 0) {
      const items: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim().length === 0) continue;
        // YAML also allows a block sequence at the key's own column
        // (`tools:\n- page_get`); anything else unindented is the next key.
        const columnZeroItem = l.startsWith("- ") || l.trimEnd() === "-";
        if (!isIndented(l) && !columnZeroItem) break;
        const t = l.trim();
        if (t.startsWith("- ")) items.push(unquote(t.slice(2).trim()));
        else if (t === "-") items.push("");
      }
      if (items.length > 0) lists[key] = items.filter((x) => x.length > 0);
      else scalars[key] = "";
      i = j - 1;
      continue;
    }

    scalars[key] = value;
  }

  const listOf = (key: string): string[] => {
    if (lists[key]) return lists[key];
    const s = scalars[key];
    return s !== undefined && s.length > 0 ? [s] : [];
  };
  const mutatingRaw = scalars["mutating"];
  const scalarOrNull = (key: string): string | null => {
    const s = scalars[key];
    return s !== undefined && s.length > 0 ? s : null;
  };

  return {
    name: scalarOrNull("name"),
    description: scalarOrNull("description"),
    triggers: listOf("triggers"),
    tools: listOf("tools"),
    mutating: mutatingRaw === "true" ? true : mutatingRaw === "false" ? false : null,
    requires: listOf("requires"),
    writes_to: listOf("writes_to"),
    unknownKeys,
    scalars,
    lists,
    keyLines,
    body,
    bodyLine,
  };
}
