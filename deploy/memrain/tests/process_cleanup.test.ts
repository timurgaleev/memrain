/**
 * process-cleanup registry — register/deregister + the cleanup pass.
 * Signal-handler installation is not exercised here (it would terminate the
 * test process); the registry + runCleanup behavior is the testable kernel.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  registerCleanup,
  _registeredCleanupCountForTests,
  _resetForTests,
} from "../src/core/process-cleanup.ts";

// Reset BEFORE each too: the registry is module-level and shared across test
// files in one `bun test` process — other suites (e.g. cycle_lock) call the real
// registerCleanup via tryAcquireDbLock and can leave entries behind.
beforeEach(() => _resetForTests());
afterEach(() => _resetForTests());

describe("registerCleanup", () => {
  it("registers a callback and deregisters idempotently", () => {
    expect(_registeredCleanupCountForTests()).toBe(0);
    const off = registerCleanup("a", async () => {});
    expect(_registeredCleanupCountForTests()).toBe(1);
    off();
    expect(_registeredCleanupCountForTests()).toBe(0);
    off(); // idempotent
    expect(_registeredCleanupCountForTests()).toBe(0);
  });

  it("keeps independent entries distinct", () => {
    const offA = registerCleanup("a", async () => {});
    registerCleanup("b", async () => {});
    expect(_registeredCleanupCountForTests()).toBe(2);
    offA();
    expect(_registeredCleanupCountForTests()).toBe(1);
  });
});


it("keeps the process alive until a stuck cleanup reaches its deadline", async () => {
  const modulePath = `${import.meta.dir}/../src/core/process-cleanup.ts`;
  const code = `import { registerCleanup, triggerCleanupAndExit } from ${JSON.stringify(modulePath)}; registerCleanup("stuck", () => new Promise(() => {})); void triggerCleanupAndExit(42);`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(42);
}, 6000);
