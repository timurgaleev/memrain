/**
 * Bedrock failures that would only repeat stop a batch run at the first one.
 *
 * Locks: the classifier reads SDK errors by name and plain errors by message
 * (an ARN's digits never pass for a 5xx); inside a batch scope an access,
 * credential or quota failure halts later calls without sending them — per
 * model for access, everywhere for credentials — while interactive calls keep
 * sending; a job that timed out cannot keep paying from its orphaned handler.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { setSpendLedgerEngine, trackedInvoke } from "../src/core/budget.ts";
import {
  classifyBedrockError,
  resetBedrockCircuitForTests,
  runInBatchScope,
} from "../src/core/llm/bedrock-errors.ts";
import { classifyFactsAbsorbError } from "../src/core/ingest-log.ts";
import { OperationError } from "../src/core/operation-error.ts";
import { Queue } from "../src/core/jobs/queue.ts";
import { Worker } from "../src/core/jobs/worker.ts";
import { _resetHandlersForTesting, registerHandler } from "../src/core/jobs/handlers.ts";

const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const TITAN = "amazon.titan-embed-text-v2:0";
const W = { input: "x", maxOutputTokens: 1 };

function sdkError(name: string, message: string, status = 400): Error {
  const e = new Error(message) as Error & { $metadata: { httpStatusCode: number } };
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}

const ACCESS = sdkError(
  "AccessDeniedException",
  "User arn:aws:iam::5550123:role/x is not authorized to perform bedrock:InvokeModel",
  403,
);

let tmp: string;
let storage: Storage;
/** Fresh store, ledger and circuit per test, for the describes that trip it. */
function useStorage(): void {
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "memrain-circuit-"));
    storage = new Storage({ dbPath: join(tmp, "db") });
    await storage.init();
    setSpendLedgerEngine(storage.engine());
    resetBedrockCircuitForTests();
  });
  afterEach(async () => {
    resetBedrockCircuitForTests();
    _resetHandlersForTesting();
    setSpendLedgerEngine(null);
    await storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });
}

describe("classifying a failure", () => {
  it("reads SDK errors by name", () => {
    expect(classifyBedrockError(ACCESS)).toBe("access");
    expect(classifyBedrockError(sdkError("ExpiredTokenException", "expired", 403))).toBe("credential");
    expect(classifyBedrockError(sdkError("ServiceQuotaExceededException", "quota"))).toBe("quota");
    expect(classifyBedrockError(sdkError("ThrottlingException", "slow down", 429))).toBe("throttle");
    expect(classifyBedrockError(sdkError("ValidationException", "Input is too long for requested model."))).toBe(
      "input_too_long",
    );
    expect(classifyBedrockError(sdkError("ValidationException", "bad field"))).toBe("other");
  });

  it("falls back to the message for a plain error", () => {
    expect(classifyBedrockError(new Error("ThrottlingException: Rate exceeded"))).toBe("throttle");
    expect(classifyBedrockError(new Error("The security token included in the request is expired"))).toBe("credential");
    // An instance-metadata hiccup clears on its own; it must not pause every model.
    expect(classifyBedrockError(new Error("Could not load credentials from any providers"))).toBe("other");
    expect(classifyBedrockError(new Error("HTTP 503"))).toBe("server");
    expect(classifyBedrockError(ACCESS)).not.toBe("server");
  });

  it("does not let an ARN's digits pass for a server error in fact extraction", () => {
    expect(classifyFactsAbsorbError(ACCESS)).toBe("pipeline_error");
    expect(classifyFactsAbsorbError(new Error("upstream returned HTTP 503"))).toBe("gateway_error");
    expect(classifyFactsAbsorbError(new OperationError("budget_exhausted", "daily budget exhausted ($0.5123)"))).toBe(
      "budget_exhausted",
    );
    const halted = new Error("BedrockHalted: paused");
    halted.name = "BedrockHalted";
    expect(classifyFactsAbsorbError(halted)).toBe("gateway_error");
  });
});

/** A paid call whose send counts its attempts and fails with `err`. */
function failingCall(model: string, err: Error, sends: { n: number }) {
  return trackedInvoke({ operation: "t", model, worstCase: W }, async () => {
    sends.n++;
    throw err;
  });
}

describe("the circuit", () => {
  useStorage();
  it("halts a batch run after the first access failure on a model", async () => {
    const sends = { n: 0 };
    const results = await runInBatchScope({ stopped: false, circuit: true }, async () =>
      Promise.allSettled(Array.from({ length: 5 }, () => failingCall(HAIKU, ACCESS, sends))).then(async () => {
        const later = await Promise.allSettled(Array.from({ length: 20 }, () => failingCall(HAIKU, ACCESS, sends)));
        return later;
      }),
    );
    expect(sends.n).toBe(5);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect(String((r as PromiseRejectedResult).reason.message)).toStartWith("BedrockHalted:");
    }
  });

  it("keeps other models open after an access failure, but not after a credential failure", async () => {
    const sends = { n: 0 };
    await runInBatchScope({ stopped: false, circuit: true }, async () => {
      await failingCall(HAIKU, ACCESS, sends).catch(() => {});
      await failingCall(TITAN, new Error("titan failed"), sends).catch(() => {});
      expect(sends.n).toBe(2);
      await failingCall(TITAN, sdkError("ExpiredTokenException", "The security token included in the request is expired", 403), sends).catch(() => {});
      await expect(failingCall(TITAN, new Error("never sent"), sends)).rejects.toThrow("BedrockHalted");
    });
    expect(sends.n).toBe(3);
  });

  it("never stops an interactive call", async () => {
    const sends = { n: 0 };
    await runInBatchScope({ stopped: false, circuit: true }, () => failingCall(HAIKU, ACCESS, sends).catch(() => {}));
    await expect(failingCall(HAIKU, ACCESS, sends)).rejects.toThrow("not authorized");
    expect(sends.n).toBe(2);
  });

  it("closes again once a call to that model goes through", async () => {
    const sends = { n: 0 };
    await runInBatchScope({ stopped: false, circuit: true }, async () => {
      await failingCall(HAIKU, ACCESS, sends).catch(() => {});
    });
    // An interactive call succeeds: the pause lifts for the batch work too.
    await trackedInvoke({ operation: "t", model: HAIKU, worstCase: W }, async () => {});
    await runInBatchScope({ stopped: false, circuit: true }, async () => {
      await failingCall(HAIKU, new Error("sent again"), sends).catch(() => {});
    });
    expect(sends.n).toBe(2);
  });

  it("is not opened by interactive failures", async () => {
    const sends = { n: 0 };
    await failingCall(HAIKU, ACCESS, sends).catch(() => {});
    await runInBatchScope({ stopped: false, circuit: true }, () => failingCall(HAIKU, new Error("sent"), sends).catch(() => {}));
    expect(sends.n).toBe(2);
  });

  it("is not read by queued jobs, whose retries would burn out inside one pause", async () => {
    const sends = { n: 0 };
    await runInBatchScope({ stopped: false, circuit: true }, () => failingCall(HAIKU, ACCESS, sends).catch(() => {}));
    await runInBatchScope({ stopped: false, circuit: false }, () => failingCall(HAIKU, new Error("sent"), sends).catch(() => {}));
    expect(sends.n).toBe(2);
  });

  it("does not open for a throttle", async () => {
    const sends = { n: 0 };
    await runInBatchScope({ stopped: false, circuit: true }, async () => {
      for (let i = 0; i < 3; i++) {
        await failingCall(HAIKU, sdkError("ThrottlingException", "slow", 429), sends).catch(() => {});
      }
    });
    expect(sends.n).toBe(3);
  });
});

describe("a job that timed out", () => {
  useStorage();
  it("cannot keep spending from its orphaned handler", async () => {
    let sentAfterTimeout = 0;
    let finished!: () => void;
    const done = new Promise<void>((r) => (finished = r));
    registerHandler("slow_paid", async () => {
      await new Promise((r) => setTimeout(r, 120));
      try {
        await trackedInvoke({ operation: "t", model: HAIKU, worstCase: W }, async () => {
          sentAfterTimeout++;
        });
      } catch {
        // halted
      } finally {
        finished();
      }
      return {};
    });
    const q = new Queue(storage.engine());
    await q.enqueue({ kind: "slow_paid", payload: {}, id: "slow-1", timeoutMs: 30, maxRetries: 0 });
    await new Worker(q, { logger: () => {} }).drainOnce();
    await done;
    expect(sentAfterTimeout).toBe(0);
  });
});
