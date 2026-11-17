import { describe, expect, it } from "bun:test";
import { workerNameFor } from "../src/core/jobs/activity.ts";

describe("workerNameFor", () => {
  it("names a registered daemon's job after the daemon", () => {
    expect(
      workerNameFor({ id: "daemon:connector_sync:me-mail:2026-11-17T10:00", kind: "connector_sync" }),
    ).toBe("connector_sync");
  });
  it("falls back to worker for an unregistered daemon id", () => {
    expect(workerNameFor({ id: "daemon:not_registered:x:y", kind: "foo" })).toBe("worker");
  });
  it("calls a subagent job the assistant", () => {
    expect(workerNameFor({ id: "abc", kind: "subagent" })).toBe("assistant");
  });
  it("calls any other job a worker", () => {
    expect(workerNameFor({ id: "abc", kind: "page_mirror" })).toBe("worker");
  });
});
