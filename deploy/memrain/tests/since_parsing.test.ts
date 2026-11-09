import { afterEach, expect, it, spyOn } from "bun:test";
import * as filters from "../src/core/search/filters.ts";
const now = Date.parse("2026-11-09T00:00:00Z");
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

it("keeps numeric hours and converts ISO and relative boundaries under caller limits", () => {
  spyOn(Date, "now").mockReturnValue(now);
  const hours = filters.resolveSinceHours;
  expect(typeof hours).toBe("function");
  expect(hours("24", 720)).toBe(24);
  expect(hours("2.5", 720)).toBe(2.5);
  expect(hours("7d", 720)).toBe(168);
  expect(hours("2026-11-08", 720)).toBe(24);
  expect(hours("2026-11-08T12:00:00Z", 720)).toBe(12);
  for (const value of ["", "-1", "0", "Infinity", "31d", "2026-11-10"]) expect(() => hours(value, 720)).toThrow();
});

it("rejects impossible calendar dates and overflowing relative bounds", () => {
  for (const value of ["2026-02-30", "2026-13-01", "999999999999999999999y"]) {
    expect(() => filters.resolveDateBoundary(value, "since")).toThrow(/Invalid since/);
    expect(() => filters.resolveDateBoundary(value, "until")).toThrow(/Invalid until/);
  }
  expect(filters.resolveDateBoundary("2024-02-29", "since")).toBe("2024-02-29T00:00:00.000Z");
});
