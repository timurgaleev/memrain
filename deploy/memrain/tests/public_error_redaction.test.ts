/**
 * Public-boundary error sanitization.
 *
 * A raw exception message can carry Postgres schema/column names, the DSN
 * host, or stack internals. `publicSafeErrorMessage` must return a generic
 * string (and log the real detail server-side) when the response may cross
 * the public ingress, while keeping the detail on the internal path so the
 * operator can still debug. Surfaced by the bug-hunter / security-engineer
 * adversarial audit (2026-06-09).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  PUBLIC_ERROR_MESSAGE,
  publicSafeErrorMessage,
} from "../src/core/public_redaction.ts";

let errSpy: ReturnType<typeof mock>;
let originalError: typeof console.error;

beforeEach(() => {
  originalError = console.error;
  errSpy = mock(() => {});
  console.error = errSpy as unknown as typeof console.error;
});

afterEach(() => {
  console.error = originalError;
});

const INCIDENT_REPLY = new RegExp(`^${PUBLIC_ERROR_MESSAGE} \\(incident ([0-9a-f]{16})\\)$`);

describe("publicSafeErrorMessage", () => {
  const leaky = new Error('relation "pages" does not exist at db.internal:5432');

  it("returns a generic message on public ingress and never the detail", () => {
    const out = publicSafeErrorMessage(leaky, true);
    expect(out).toMatch(INCIDENT_REPLY);
    expect(out).not.toContain("pages");
    expect(out).not.toContain("db.internal");
  });

  it("logs the real detail server-side on public ingress", () => {
    publicSafeErrorMessage(leaky, true);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain('relation "pages" does not exist');
  });

  it("gives each suppressed error an incident id the operator log carries too", () => {
    const first = publicSafeErrorMessage(leaky, true);
    const second = publicSafeErrorMessage(leaky, true);
    const id1 = INCIDENT_REPLY.exec(first)?.[1];
    const id2 = INCIDENT_REPLY.exec(second)?.[1];
    expect(id1).toBeDefined();
    expect(id1).not.toBe(id2);
    expect(errSpy.mock.calls[0]!.join(" ")).toContain(`incident ${id1}`);
    expect(errSpy.mock.calls[1]!.join(" ")).toContain(`incident ${id2}`);
  });

  it("returns the full detail on the internal path and does not log", () => {
    const out = publicSafeErrorMessage(leaky, false);
    expect(out).toBe(leaky.message);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("coerces non-Error throwables (string) without leaking them publicly", () => {
    const out = publicSafeErrorMessage("ECONNREFUSED 10.0.0.5:5432", true);
    expect(out).toMatch(INCIDENT_REPLY);
    expect(out).not.toContain("10.0.0.5");
    expect(publicSafeErrorMessage("plain string", false)).toBe("plain string");
  });

  it("coerces non-Error throwables (object) on the internal path", () => {
    expect(publicSafeErrorMessage({ code: "42P01" }, false)).toBe(
      "[object Object]",
    );
  });

  // The detail is a single `.message` an attacker can shape, and it lands in a
  // line-oriented operator log. Left intact, a CRLF ends the real line and the
  // rest of the message becomes a second, fully forged one.
  it("collapses control characters so a crafted message cannot forge a log line", () => {
    const CRLF = String.fromCharCode(13, 10); // no literal control char in source
    const ESC = String.fromCharCode(27);
    const NUL = String.fromCharCode(0);
    publicSafeErrorMessage(
      new Error(`boom${CRLF}[memex] all clear${NUL}${ESC}[2J`),
      true,
    );
    const logged = errSpy.mock.calls[0]!.join(" ");
    expect(logged).not.toContain(CRLF);
    expect(logged).not.toContain(String.fromCharCode(10));
    expect(logged).not.toContain(String.fromCharCode(13));
    expect(logged).not.toContain(NUL);
    expect(logged).not.toContain(ESC);
    // The diagnosis itself still reaches the operator.
    expect(logged).toContain("boom");
  });

  // A Postgres DETAIL clause can append the whole offending row; the cap bounds
  // how much note-derived data one failure drags into the log.
  it("caps a runaway detail and marks the truncation", () => {
    publicSafeErrorMessage(new Error(`prefix ${"x".repeat(5000)}`), true);
    const logged = errSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("prefix");
    expect(logged).toContain("[truncated]");
    expect(logged.length).toBeLessThan(700);
  });
});
