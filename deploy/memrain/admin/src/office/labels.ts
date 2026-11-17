// A name tag over a figure, in CSS px: x is its centre, y its bottom edge.
export interface LabelBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // Busy figures always keep their tag; idle ones give way.
  keep: boolean;
}

export interface LabelSpot {
  x: number;
  lift: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const GAP = 1;
// Sideways steps, in tag widths, tried when a busy tag cannot rise any further.
const STEPS = [0, 1, -1, 2, -2, 3, -3];

function overlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// Lift a tag at x until it covers no placed tag.
function stack(b: LabelBox, x: number, placed: readonly Rect[]): { rect: Rect; lift: number } {
  let lift = 0;
  for (;;) {
    const rect = { left: x - b.w / 2, right: x + b.w / 2, top: b.y - lift - b.h, bottom: b.y - lift };
    const hit = placed.find((p) => overlap(rect, p));
    if (!hit) return { rect, lift };
    lift = b.y - hit.top + GAP;
  }
}

// Where each tag goes so none covers another: busy tags first, then from the front of
// the room to the back, each lifted above what it would cover. A busy tag that would
// rise past the stage top steps sideways instead, or is pinned to the top edge when
// no step is free; an idle tag that would rise past maxLift or the top is hidden (null).
export function spreadLabels(boxes: readonly LabelBox[], maxLift: number, stageW: number): Map<string, LabelSpot | null> {
  const order = [...boxes].sort((a, b) => Number(b.keep) - Number(a.keep) || b.y - a.y);
  const placed: Rect[] = [];
  const spots = new Map<string, LabelSpot | null>();
  for (const b of order) {
    const fits = (lift: number) => b.y - lift >= b.h;
    let best: { rect: Rect; lift: number; x: number } | null = null;
    for (const step of b.keep ? STEPS : [0]) {
      const x = Math.min(Math.max(b.x + step * (b.w + GAP), b.w / 2), Math.max(b.w / 2, stageW - b.w / 2));
      const at = { ...stack(b, x, placed), x };
      if (!best || (fits(at.lift) && !fits(best.lift))) best = at;
      if (fits(at.lift)) break;
    }
    if (!best || (!b.keep && (best.lift > maxLift || !fits(best.lift)))) {
      spots.set(b.id, null);
      continue;
    }
    // Nowhere free inside the stage: pin the tag to the top edge, even over another one.
    const lift = Math.min(best.lift, b.y - b.h);
    placed.push({ ...best.rect, top: b.y - lift - b.h, bottom: b.y - lift });
    spots.set(b.id, { x: best.x, lift });
  }
  return spots;
}
