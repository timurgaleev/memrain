/**
 * Durable spend ledger for a LongMemEval run: one JSONL file, appended and
 * fsynced record by record.
 *
 * Every paid call is reserved before it is sent — its worst-case price and the
 * bounds that price assumes — and settled after the provider reports usage.
 * A reservation with no settlement is charged in full: the call may have been
 * billed before the process died, so a resumed run never gets that budget
 * back. Only the operator can release it, with `--settle <id> --usd <amount>`
 * from the provider bill, and that too is written to the ledger.
 *
 * Writes are synchronous, so a check against the cap and the reservation that
 * follows it cannot interleave with another call in the same process.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync } from "node:fs";
import { randomUUID } from "node:crypto";

export class CapExceeded extends Error {
  override name = "CapExceeded";
}

export type Stage = "embed" | "query_embed" | "answer" | "judge";

export interface ReserveInput {
  question_id: string;
  stage: Stage;
  model: string;
  /** Worst-case price of the call at its bounds below. */
  max_usd: number;
  max_input_bytes: number;
  /** Output tokens the call is allowed (0 for an embedding). */
  max_tokens: number;
}

export interface SettleInput {
  usd: number;
  outcome: "ok" | "error";
  /** "reservation": usage was not reported, so the call is charged its worst case. */
  source: "reported" | "reservation";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ReserveRecord extends ReserveInput {
  t: "reserve";
  id: string;
  at: string;
}

export type LedgerRecord =
  | { t: "run"; at: string; header: Record<string, unknown> }
  | { t: "cap"; at: string; max_usd: number }
  | ReserveRecord
  | ({ t: "settle"; id: string; at: string } & SettleInput)
  | { t: "operator_settle"; id: string; at: string; usd: number }
  | { t: "result"; at: string; question_id: string; [k: string]: unknown };

export type ResultRecord = Extract<LedgerRecord, { t: "result" }>;

export class SpendLedger {
  private readonly reservations = new Map<string, ReserveRecord>();
  private readonly settled = new Map<string, number>();
  private readonly resultsByQuestion = new Map<string, ResultRecord>();
  private runHeader: Record<string, unknown> | null = null;
  private committed = 0;

  private constructor(private readonly path: string) {}

  static open(path: string): SpendLedger {
    const ledger = new SpendLedger(path);
    if (!existsSync(path)) return ledger;
    let text = readFileSync(path, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) {
      // A record is written with its newline in one append; text after the
      // last newline is a write the process died in, made before its call.
      truncateSync(path, Buffer.byteLength(text.slice(0, end)));
      text = text.slice(0, end);
    }
    const lines = text.split("\n").slice(0, -1);
    lines.forEach((line, i) => {
      let rec: LedgerRecord;
      try {
        rec = JSON.parse(line) as LedgerRecord;
      } catch {
        throw new Error(`${path}: line ${i + 1} is not a ledger record`);
      }
      ledger.apply(rec);
    });
    return ledger;
  }

  private apply(rec: LedgerRecord): void {
    switch (rec.t) {
      case "run":
        this.runHeader ??= rec.header;
        break;
      case "reserve":
        this.reservations.set(rec.id, rec);
        this.committed += rec.max_usd;
        break;
      case "settle":
      case "operator_settle": {
        const r = this.reservations.get(rec.id);
        if (!r || this.settled.has(rec.id)) break;
        this.settled.set(rec.id, rec.usd);
        this.committed += rec.usd - r.max_usd;
        break;
      }
      case "result":
        this.resultsByQuestion.set(rec.question_id, rec);
        break;
      default:
        break;
    }
  }

  private append(rec: LedgerRecord): void {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    const fd = openSync(this.path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.apply(rec);
  }

  header(): Record<string, unknown> | null {
    return this.runHeader;
  }

  writeHeader(header: Record<string, unknown>): void {
    this.append({ t: "run", at: new Date().toISOString(), header });
  }

  recordCap(maxUsd: number): void {
    this.append({ t: "cap", at: new Date().toISOString(), max_usd: maxUsd });
  }

  /** Settled spend plus every open reservation at its full worst case. */
  spentUsd(): number {
    return this.committed;
  }

  unsettled(): ReserveRecord[] {
    return [...this.reservations.values()].filter((r) => !this.settled.has(r.id));
  }

  /** Questions with at least one reservation — a paid call was at least attempted. */
  questionsWithCalls(): Set<string> {
    return new Set([...this.reservations.values()].map((r) => r.question_id));
  }

  /** Settled-or-reserved spend of one question's calls. */
  questionSpendUsd(questionId: string): number {
    let usd = 0;
    for (const r of this.reservations.values()) {
      if (r.question_id === questionId) usd += this.settled.get(r.id) ?? r.max_usd;
    }
    return usd;
  }

  results(): ReadonlyMap<string, ResultRecord> {
    return this.resultsByQuestion;
  }

  /** Reserve a call's worst case, or throw CapExceeded without writing anything. */
  reserve(input: ReserveInput, capUsd: number): string {
    if (!Number.isFinite(input.max_usd) || input.max_usd < 0) {
      throw new CapExceeded(`${input.stage} call has no finite worst-case price`);
    }
    if (this.committed + input.max_usd > capUsd) {
      throw new CapExceeded(
        `${input.stage} call for ${input.question_id} needs up to $${input.max_usd.toFixed(6)}; ` +
          `$${this.committed.toFixed(6)} of the $${capUsd} cap is already spent or reserved`,
      );
    }
    const id = randomUUID();
    this.append({ t: "reserve", id, at: new Date().toISOString(), ...input });
    return id;
  }

  settle(id: string, s: SettleInput): void {
    if (!this.reservations.has(id)) throw new Error(`settle: unknown reservation ${id}`);
    if (this.settled.has(id)) throw new Error(`settle: reservation ${id} is already settled`);
    this.append({ t: "settle", id, at: new Date().toISOString(), ...s });
  }

  /** The operator records what the provider billed for a call the run never settled. */
  operatorSettle(id: string, usd: number): void {
    if (!this.reservations.has(id)) throw new Error(`unknown reservation ${id}`);
    if (this.settled.has(id)) throw new Error(`reservation ${id} is already settled`);
    if (!Number.isFinite(usd) || usd < 0) throw new Error(`settle amount must be a non-negative number of USD, got ${usd}`);
    this.append({ t: "operator_settle", id, at: new Date().toISOString(), usd });
  }

  appendResult(questionId: string, fields: Record<string, unknown>): void {
    this.append({ ...fields, t: "result", at: new Date().toISOString(), question_id: questionId });
  }
}
