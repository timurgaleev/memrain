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

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const GAP = 1;

function overlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// How far to lift each tag so none covers another: busy tags first, then from the
// front of the room to the back. An idle tag that would rise past maxLift is hidden (null).
export function spreadLabels(boxes: readonly LabelBox[], maxLift: number): Map<string, number | null> {
  const order = [...boxes].sort((a, b) => Number(b.keep) - Number(a.keep) || b.y - a.y);
  const placed: Rect[] = [];
  const lifts = new Map<string, number | null>();
  for (const b of order) {
    let lift = 0;
    let rect: Rect;
    for (;;) {
      rect = { left: b.x - b.w / 2, right: b.x + b.w / 2, top: b.y - lift - b.h, bottom: b.y - lift };
      const hit = placed.find((p) => overlap(rect, p));
      if (!hit) break;
      lift = b.y - hit.top + GAP;
    }
    if (!b.keep && lift > maxLift) {
      lifts.set(b.id, null);
      continue;
    }
    placed.push(rect);
    lifts.set(b.id, lift);
  }
  return lifts;
}
