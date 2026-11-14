import { describe, expect, it } from "bun:test";
import { CronError, assertTimeZone, nextFire, parseCron, previousFire, windowKey } from "../src/core/daemons/cron.ts";

const BERLIN = "Europe/Berlin";

/** Every fire in [from, to), walked with nextFire. */
function firesBetween(expr: string, tz: string, from: string, to: string): string[] {
  const cron = parseCron(expr);
  const end = new Date(to).getTime();
  const out: string[] = [];
  let cursor = new Date(new Date(from).getTime() - 1);
  for (let i = 0; i < 10_000; i++) {
    const f = nextFire(cron, cursor, tz);
    if (!f || f.at.getTime() >= end) break;
    out.push(`${windowKey(f, tz)}=${f.at.toISOString()}`);
    cursor = f.at;
  }
  return out;
}

describe("parseCron", () => {
  it("rejects malformed expressions and names the field", () => {
    expect(() => parseCron("* * *")).toThrow(CronError);
    expect(() => parseCron("61 * * * *")).toThrow("minute");
    expect(() => parseCron("* 24 * * *")).toThrow("hour");
    expect(() => parseCron("* * 0 * *")).toThrow("day-of-month");
    expect(() => parseCron("* * * 13 *")).toThrow("month");
    expect(() => parseCron("* * * * 8")).toThrow("day-of-week");
    expect(() => parseCron("*/0 * * * *")).toThrow("step");
    expect(() => parseCron("5-1 * * * *")).toThrow("range");
    expect(() => parseCron("a b c d e")).toThrow(CronError);
    expect(() => parseCron("1,,2 * * * *")).toThrow(CronError);
  });

  it("rejects a date that never occurs", () => {
    expect(() => parseCron("0 0 31 2 *")).toThrow("never fires");
    expect(() => parseCron("0 0 30 2,4 *")).not.toThrow();
  });

  it("treats day-of-week 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").weekdays).toEqual([0]);
  });
});

describe("assertTimeZone", () => {
  it("accepts IANA names and refuses anything else", () => {
    expect(assertTimeZone(BERLIN)).toBe(BERLIN);
    expect(() => assertTimeZone("Mars/Olympus")).toThrow("time zone");
  });
});

describe("cron windows in an IANA zone", () => {
  it("0 7 * * * fires exactly once on the spring-forward morning", () => {
    expect(firesBetween("0 7 * * *", BERLIN, "2026-03-28T23:00:00Z", "2026-03-29T23:00:00Z"))
      .toEqual(["2026-03-29T07:00@Europe/Berlin=2026-03-29T05:00:00.000Z"]);
  });

  it("0 7 * * * fires exactly once on the fall-back morning", () => {
    expect(firesBetween("0 7 * * *", BERLIN, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"))
      .toEqual(["2026-10-25T07:00@Europe/Berlin=2026-10-25T06:00:00.000Z"]);
  });

  it("a wall time skipped by spring-forward fires once, right after the gap", () => {
    expect(firesBetween("30 2 * * *", BERLIN, "2026-03-28T23:00:00Z", "2026-03-29T23:00:00Z"))
      .toEqual(["2026-03-29T02:30@Europe/Berlin=2026-03-29T01:30:00.000Z"]);
  });

  it("a wall time repeated by fall-back is one window, at its first occurrence", () => {
    expect(firesBetween("30 2 * * *", BERLIN, "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z"))
      .toEqual(["2026-10-25T02:30@Europe/Berlin=2026-10-25T00:30:00.000Z"]);
  });

  it("*/15 gives four windows an hour", () => {
    expect(firesBetween("*/15 * * * *", "UTC", "2026-11-15T10:00:00Z", "2026-11-15T11:00:00Z")).toHaveLength(4);
  });

  it("day-of-month and day-of-week both restricted fire on either", () => {
    const fires = firesBetween("0 12 13 * 5", "UTC", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")
      .map(f => f.slice(0, 10));
    expect(fires).toEqual(["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"]);
  });

  it("previousFire returns the latest window at or before now", () => {
    const cron = parseCron("0 7 * * *");
    const at = previousFire(cron, new Date("2026-11-15T06:00:00Z"), BERLIN)!;
    expect(windowKey(at, BERLIN)).toBe("2026-11-15T07:00@Europe/Berlin");
    expect(at.at.toISOString()).toBe("2026-11-15T06:00:00.000Z");
    const before = previousFire(cron, new Date("2026-11-15T05:59:59Z"), BERLIN)!;
    expect(windowKey(before, BERLIN)).toBe("2026-11-14T07:00@Europe/Berlin");
  });

  it("finds a leap-day window years away", () => {
    const f = previousFire(parseCron("0 0 29 2 *"), new Date("2027-06-01T00:00:00Z"), "UTC")!;
    expect(f.at.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
});
