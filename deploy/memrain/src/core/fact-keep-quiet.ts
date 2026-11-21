/**
 * A claim the speaker asked to keep quiet ("keep this quiet for now, but ...",
 * "between us", "off the record") is stored private. Deterministic and
 * English only: the extractor prompt is unchanged, and a fact is marked only
 * when its words match the claim of a keep-quiet sentence in its own window.
 * Marking only narrows a fact's visibility, so the owner's reads are unchanged.
 */

const CUE = /\b(?:keep (?:this|it|that) (?:quiet|between us|to yourself|under wraps|on the down ?low)|off the record|(?:do not|don'?t) (?:share|repeat|spread) (?:this|it|that)|(?:do not|don'?t) tell anyone)\b|^(?:just |strictly )?between (?:you and me|us|ourselves)(?=\s*(?:[,.:;!]|$|but\b))/i;
const STOP = new Set(("the and but for now this that these those with from into onto about after before over under just also very "
  + "its it's his her their our your you they them she him was were are has have had will would could should can may might "
  + "not yet any all some more most then than when what which who whom whose where why how been being one two get got "
  + "user assistant quiet keep anyway meanwhile switching topics another note").split(" "));

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2 && !STOP.has(w)));
}

/**
 * The word sets of the claims a window's keep-quiet sentences name: the words
 * after the cue, else the rest of its sentence, else the neighbouring sentence
 * of the same message that the cue refers to.
 * An assistant message ("I will keep that quiet") names no claim.
 */
export function keepQuietClaims(messages: ReadonlyArray<{ speaker: string; text: string }>): Set<string>[] {
  return messages.filter((message) => message.speaker.trim().toLowerCase() !== "assistant").flatMap((message) => {
    const sentences = message.text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim().replace(/^[^\p{L}\p{N}]+/u, "")).filter(Boolean);
    return sentences.flatMap((sentence, i) => {
      const cue = CUE.exec(sentence);
      if (!cue) return [];
      const after = words(sentence.slice(cue.index + cue[0].length));
      if (after.size >= 2) return [after];
      const rest = words(`${sentence.slice(0, cue.index)} ${sentence.slice(cue.index + cue[0].length)}`);
      if (rest.size >= 2) return [rest];
      // A cue sentence with no claim of its own names its neighbour: the next
      // sentence when it opens with the cue ("Between us. ..."), else the one
      // before it ("... Please don't share this.").
      const next = words(sentences[i + 1] ?? "");
      const prev = words(sentences[i - 1] ?? "");
      return cue.index === 0 && next.size >= 2 ? [next] : prev.size >= 2 ? [prev] : [];
    });
  });
}

/**
 * True when the fact restates one keep-quiet claim: at least two shared words
 * making up half the fact's words, or at least three making up three quarters
 * of the claim's (a longer fact that carries the whole claim).
 */
export function keptQuiet(fact: string, claims: readonly Set<string>[]): boolean {
  if (!claims.length) return false;
  const own = words(fact);
  return claims.some((claim) => {
    let shared = 0;
    for (const w of own) if (claim.has(w)) shared++;
    return (shared >= 2 && shared * 2 >= own.size) || (shared >= 3 && shared * 4 >= claim.size * 3);
  });
}

/** A turn label: `Name:`, `**Name:**`, `**Name** (time):` or `Name (time):`; null for any other line. */
function turnOf(line: string): { speaker: string; text: string } | null {
  // The time a label may carry can hold a colon of its own ("9:03 AM").
  const unstamped = line.replace(/\([^()\n]{0,40}\)/, "");
  const colon = unstamped.indexOf(":");
  if (colon < 1) return null;
  const speaker = unstamped.slice(0, colon).replaceAll("*", "").trim();
  const text = unstamped.slice(colon + 1).replace(/^\*+/, "").trim();
  return speaker && speaker.length <= 60 && !/[.!?]/.test(speaker) && text ? { speaker, text } : null;
}

/**
 * An extraction window as speaker turns. A line with no turn label continues
 * the turn before it; text before the first label has no speaker.
 */
export function windowMessages(window: string): Array<{ speaker: string; text: string }> {
  const out: Array<{ speaker: string; text: string }> = [];
  for (const line of window.split("\n")) {
    const turn = turnOf(line);
    if (turn) out.push(turn);
    else if (out.length) out[out.length - 1]!.text += `\n${line}`;
    else out.push({ speaker: "", text: line });
  }
  return out;
}
