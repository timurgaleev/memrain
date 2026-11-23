/**
 * Doctor check vocabulary: how bad an answer is (status), and the verdict
 * shape every check reports.
 */

/**
 * Three-state check outcome:
 *
 *   - ok   : the check ran and the brain looks right on that axis.
 *   - warn : a real signal that must not gate — a degraded-but-running brain,
 *            or a check that could not run at all. `ok` stays true, so the
 *            process exit code (what every cron probe reads) is unmoved.
 *   - fail : the brain is broken on that axis; `ok` is false and `doctor`
 *            exits 1.
 *
 * `ok` is the back-compat exit-code view of `status`: `ok === (status !==
 * "fail")`. A check that THREW is a `warn`, never an `ok` — the doctor is not
 * allowed to render "I could not check this" as "this is fine".
 */
export type CheckStatus = "ok" | "warn" | "fail";

/** The full verdict a check reports. `detail` is what the operator reads. */
export interface CheckVerdict {
  name: string;
  ok: boolean;
  status: CheckStatus;
  detail: string;
}

/** Worst outcome of a set: fail beats warn beats ok. */
export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = "ok";
  for (const s of statuses) {
    if (s === "fail") return "fail";
    if (s === "warn") worst = "warn";
  }
  return worst;
}

/**
 * The verdict for a probe that THREW.
 *
 * The doctor deliberately treats a throw as `warn`. It is a one-shot probe
 * over a live brain and some of its probes read OPTIONAL substrate (a table a
 * pre-migration brain lacks). Failing the exit code on those would red every
 * cron probe on a brain that is serving fine. What must never happen is a
 * throw rendered byte-identical to a pass. `warn` keeps the exit code honest
 * AND the report honest.
 *
 * One phrasing for every such detail so an operator (and a grep) recognises
 * "I could not check" wherever it comes from.
 */
export function couldNotCheck(
  name: string,
  e: unknown,
  hint?: string,
): CheckVerdict {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    name,
    ok: true,
    status: "warn",
    detail: `could not check ${name}: ${msg}${hint ? ` (${hint})` : ""}`,
  };
}
