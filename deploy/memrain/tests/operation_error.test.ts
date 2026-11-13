/**
 * OperationError — structured, agent-consumable error envelope, with the
 * memrain public-ingress redaction contract.
 *
 * Unit: `toEnvelope` withholds the free-text `message` on the public boundary
 * but keeps the constrained `error` code + author-static `suggestion`/`docs`.
 * Integration: a handler that throws OperationError renders the envelope
 * through `dispatchTool`'s catch (internal keeps the message, public drops it);
 * a raw exception stays on the fully-redacted path.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATION_ERROR_CODES,
  OperationError,
  isOperationError,
} from "../src/core/operation-error.ts";
import { databaseOperationError } from "../src/core/database-error.ts";
import { Storage } from "../src/core/storage.ts";
import { dispatchTool } from "../src/mcp/dispatch.ts";

describe("OperationError envelope", () => {
  const e = new OperationError(
    "invalid_params",
    "search: `k` must be an integer in [1, 100]",
    "Pass `k` between 1 and 100.",
    "docs/search.md",
  );

  it("internal envelope carries the full detail including message", () => {
    expect(e.toEnvelope(false)).toEqual({
      error: "invalid_params",
      error_class: "invalid_request",
      retryable: false,
      message: "search: `k` must be an integer in [1, 100]",
      suggestion: "Pass `k` between 1 and 100.",
      docs: "docs/search.md",
    });
  });

  it("public envelope withholds the free-text message", () => {
    const pub = e.toEnvelope(true);
    expect(pub).toEqual({
      error: "invalid_params",
      error_class: "invalid_request",
      retryable: false,
      suggestion: "Pass `k` between 1 and 100.",
      docs: "docs/search.md",
    });
    expect("message" in pub).toBe(false);
    // Invariant (security-enforced, not just review-enforced): the serialized
    // public envelope leaks neither the free-text message nor any Error
    // internals (stack/name) — toEnvelope builds a fresh literal, never the
    // OperationError instance.
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("\"name\"");
  });

  it("omits undefined optional fields", () => {
    const bare = new OperationError("not_found", "nope");
    expect(bare.toEnvelope(false)).toEqual({ error: "not_found", error_class: "not_found", retryable: false, message: "nope" });
    expect(bare.toEnvelope(true)).toEqual({ error: "not_found", error_class: "not_found", retryable: false });
  });

  it("isOperationError discriminates", () => {
    expect(isOperationError(e)).toBe(true);
    expect(isOperationError(new Error("plain"))).toBe(false);
    expect(isOperationError("string")).toBe(false);
  });
});

describe("OperationError class and retryable", () => {
  it("every code has a class and a retryable flag", () => {
    for (const code of OPERATION_ERROR_CODES) {
      const env = new OperationError(code, "m").toEnvelope(true) as unknown as Record<string, unknown>;
      expect(typeof env.error_class).toBe("string");
      expect(typeof env.retryable).toBe("boolean");
    }
  });

  it("marks transient failures retryable on both boundaries", () => {
    for (const code of ["db_busy", "db_timeout", "storage_error", "rate_limited", "request_in_progress"] as const) {
      const e = new OperationError(code, "secret detail");
      expect(e.toEnvelope(false)).toMatchObject({ error: code, retryable: true });
      const pub = e.toEnvelope(true);
      expect(pub).toMatchObject({ error: code, retryable: true });
      expect("message" in pub).toBe(false);
    }
  });

  it("marks permanent failures not retryable, with their class", () => {
    const cases = [
      ["invalid_params", "invalid_request"],
      ["permission_denied", "permission"],
      ["insufficient_scope", "permission"],
      ["not_found", "not_found"],
      ["version_conflict", "conflict"],
      ["budget_exhausted", "limit"],
      ["page_shrink_refused", "refused"],
    ] as const;
    for (const [code, errorClass] of cases) {
      const pub = new OperationError(code, "secret detail").toEnvelope(true);
      expect(pub).toEqual({ error: code, error_class: errorClass, retryable: false });
    }
  });

  it("the database classifier carries the transient class", () => {
    const e = databaseOperationError(Object.assign(new Error("x"), { code: "40P01" }))!;
    expect(e.toEnvelope(true)).toMatchObject({ error: "db_busy", error_class: "transient", retryable: true, sqlstate: "40P01" });
  });
});

describe("dispatchTool renders OperationError", () => {
  let tmp: string;
  let storage: Storage;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-operr-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
  });
  afterAll(async () => {
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("internal ingress: invalid search params return the full envelope", async () => {
    const res = await dispatchTool(storage, { name: "search", arguments: {} }, {
      isPublic: false,
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error).toBe("invalid_params");
    expect(env.message).toContain("`q` is required");
    expect(env.suggestion).toBeDefined();
  });

  it("public ingress: the same error drops the free-text message", async () => {
    const res = await dispatchTool(storage, { name: "search", arguments: {} }, {
      isPublic: true,
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error).toBe("invalid_params");
    expect(env.message).toBeUndefined(); // withheld on public
    expect(env.suggestion).toBeDefined();
  });

  it("unknown tool throws a not_found envelope", async () => {
    const res = await dispatchTool(storage, { name: "no-such-tool" }, {
      isPublic: false,
    });
    expect(res.isError).toBe(true);
    const env = JSON.parse(res.content[0]!.text);
    expect(env.error).toBe("not_found");
  });
});
