export interface Tile {
  x: number;
  y: number;
}

const STEPS: readonly Tile[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

// Breadth-first search on a 4-neighbour grid. The path leaves out `from` and
// ends on `to`; [] means there is nowhere to go (unreachable, blocked or already there).
export function findPath(
  from: Tile,
  to: Tile,
  walkable: (x: number, y: number) => boolean,
  width: number,
  height: number,
): Tile[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  if (!inside(from.x, from.y) || !inside(to.x, to.y) || !walkable(to.x, to.y)) return [];
  if (from.x === to.x && from.y === to.y) return [];

  const start = from.y * width + from.x;
  const goal = to.y * width + to.x;
  const prev = new Int32Array(width * height).fill(-1);
  prev[start] = start;
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (cur === goal) break;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    for (const s of STEPS) {
      const nx = cx + s.x;
      const ny = cy + s.y;
      if (!inside(nx, ny) || !walkable(nx, ny)) continue;
      const n = ny * width + nx;
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      queue.push(n);
    }
  }
  if (prev[goal] === -1) return [];

  const path: Tile[] = [];
  for (let at = goal; at !== start; at = prev[at]!) path.push({ x: at % width, y: Math.floor(at / width) });
  return path.reverse();
}
