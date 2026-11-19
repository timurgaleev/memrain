import { describe, expect, it } from "bun:test";
import { DRAG_FULL_RATE_MS, FRAME_MS, ORBIT_IDLE_MS, orbitAwake, shouldDraw } from "../admin/src/office/pacing.ts";

describe("frame pacing", () => {
  const NO_DRAG = -Infinity;
  // Feeds display frames at `hz` with optional wobble and counts the frames drawn.
  function drawsOver(ms: number, hz: number, opts: { from?: number; lastDraw?: number | null; dragAt?: number; wobble?: number } = {}) {
    let lastDraw = opts.lastDraw ?? null;
    const times: number[] = [];
    const from = opts.from ?? 0;
    for (let i = 0; i * (1000 / hz) < ms; i++) {
      const t = from + i * (1000 / hz) + (opts.wobble ? ((((i * 7919) % 11) - 5) / 10) * opts.wobble : 0);
      if (shouldDraw(lastDraw, t, opts.dragAt ?? NO_DRAG)) {
        lastDraw = t;
        times.push(t);
      }
    }
    return times;
  }

  it("draws the first frame at once", () => {
    expect(shouldDraw(null, 5000, NO_DRAG)).toBe(true);
  });

  it("draws about 30 frames a second on 60, 120 and 144 Hz displays", () => {
    for (const hz of [60, 120, 144]) {
      const n = drawsOver(10_000, hz).length;
      expect(n).toBeLessThanOrEqual(301);
      expect(n).toBeGreaterThanOrEqual(hz === 144 ? 240 : 295);
    }
  });

  it("stays at or under 31 a second when the display's timestamps wobble", () => {
    const times = drawsOver(10_000, 60, { wobble: 1 });
    for (let s = 0; s < 10; s++) expect(times.filter((t) => t >= s * 1000 && t < (s + 1) * 1000).length).toBeLessThanOrEqual(31);
  });

  it("keeps the gap between frames near a 30 fps frame, never a 60 fps one", () => {
    const times = drawsOver(5000, 60, { wobble: 1 });
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThan(FRAME_MS - 2);
  });

  it("draws every display frame for a second after a drag, then drops back", () => {
    const dragAt = 1000;
    const during = drawsOver(DRAG_FULL_RATE_MS - 1, 60, { from: dragAt, dragAt }).length;
    expect(during).toBe(60);
    const after = drawsOver(1000, 60, { from: dragAt + DRAG_FULL_RATE_MS + 1, dragAt, lastDraw: dragAt + DRAG_FULL_RATE_MS - 10 }).length;
    expect(after).toBeLessThanOrEqual(31);
  });

  it("does not catch up in a burst after a long pause", () => {
    expect(shouldDraw(0, 60_000, NO_DRAG)).toBe(true);
    expect(shouldDraw(60_000, 60_000 + 1000 / 60, NO_DRAG)).toBe(false);
  });
});

describe("camera orbit idle", () => {
  it("keeps turning for two minutes after the last pointer use or office change, then stops", () => {
    expect(orbitAwake(1000, 1000)).toBe(true);
    expect(orbitAwake(1000 + ORBIT_IDLE_MS - 1, 1000)).toBe(true);
    expect(orbitAwake(1000 + ORBIT_IDLE_MS, 1000)).toBe(false);
    expect(orbitAwake(1000 + ORBIT_IDLE_MS * 3, 1000 + ORBIT_IDLE_MS * 3 - 5)).toBe(true);
  });
});
