// How often the 3D office draws, and when its camera stops turning on its own.
export const FRAME_MS = 1000 / 30;
// Right after a drag the view follows the pointer at the display's own rate.
export const DRAG_FULL_RATE_MS = 1000;
// The camera's slow turn stops after this long with no pointer and no office news.
export const ORBIT_IDLE_MS = 2 * 60_000;
// Frame timestamps wobble a little; without slack a 60 Hz display would sometimes
// wait a third frame. It still keeps the rate under 31 a second.
const SLACK_MS = 1;

export function shouldDraw(lastDrawAt: number | null, now: number, lastDragAt: number): boolean {
  if (lastDrawAt === null || now - lastDragAt < DRAG_FULL_RATE_MS) return true;
  return now - lastDrawAt >= FRAME_MS - SLACK_MS;
}

export function orbitAwake(now: number, lastActivityAt: number): boolean {
  return now - lastActivityAt < ORBIT_IDLE_MS;
}
