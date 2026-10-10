/**
 * The embed-gaps cycle phase and the embedding backlog doctor check.
 *
 * Locks: chunks written without a vector get one from the cycle, at most
 * MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE per tick, never with MEMRAIN_EMBED_GAPS=0;
 * the phase is part of the default cycle, skipped in quiet hours like the other
 * Bedrock phases, and its paid calls carry the phase spend tag. The doctor warns
 * only on a backlog that is both large and a day old.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/core/storage.ts";
import { EMBED_DIMENSIONS } from "../src/core/embedding.ts";
import { embedGapsPhase, embedGapsMaxPerCycle } from "../src/core/cycle/embed-gaps.ts";
import { ALL_PHASES, runPhase } from "../src/core/cycle/index.ts";
import { selectTickPhases } from "../src/recipes/cycle.ts";
import { currentSpendTags } from "../src/core/budget.ts";
import { NOOP_PROGRESS } from "../src/core/output/progress.ts";
import { checkEmbedBacklog } from "../src/core/doctor-embed.ts";

let tmp: string;
let storage: Storage;
const saved = { gaps: process.env.MEMRAIN_EMBED_GAPS, max: process.env.MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE };

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "memrain-embed-gaps-"));
  storage = new Storage({ dbPath: join(tmp, "db") });
  await storage.init();
  delete process.env.MEMRAIN_EMBED_GAPS;
  delete process.env.MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE;
});

afterEach(async () => {
  for (const [k, v] of [["MEMRAIN_EMBED_GAPS", saved.gaps], ["MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE", saved.max]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await storage.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** `n` vector-less chunks on one document, written `ageHours` ago. */
async function seedGaps(n: number, ageHours = 0, doc = "d1"): Promise<void> {
  const e = storage.engine();
  await e.query(
    `INSERT INTO documents (id, source_path, title, frontmatter, updated_at)
     VALUES ($1, $2, 'T', '{}'::jsonb, now() - ($3 || ' hours')::interval)`,
    [doc, `/vault/${doc}.md`, String(ageHours)],
  );
  await e.query(
    `INSERT INTO chunks (id, document_id, chunk_index, content)
     SELECT $1 || '_c' || lpad(g::text, 5, '0'), $1, g, 'gap chunk number ' || g
       FROM generate_series(0, $2::int - 1) AS g`,
    [doc, n],
  );
}

async function embeddedCount(): Promise<number> {
  const r = await storage.engine().query<{ n: number }>(`SELECT count(*)::int AS n FROM embeddings`);
  return r.rows[0]!.n;
}

const embed = async () => Array.from<number>({ length: EMBED_DIMENSIONS }).fill(0.02);

describe("embed-gaps phase", () => {
  it("fills vector-less chunks up to the per-cycle cap", async () => {
    await seedGaps(120);
    const r = await embedGapsPhase(storage.engine(), { maxPerCycle: 70, embed });
    expect(r).toMatchObject({ ran: true, scanned: 70, embedded: 70, failed: 0 });
    expect(await embeddedCount()).toBe(70);
    const next = await embedGapsPhase(storage.engine(), { maxPerCycle: 70, embed });
    expect(next.embedded).toBe(50);
    expect(await embeddedCount()).toBe(120);
  });

  it("reads its cap from MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE, default 200", async () => {
    expect(embedGapsMaxPerCycle({})).toBe(200);
    expect(embedGapsMaxPerCycle({ MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE: "15" })).toBe(15);
    expect(embedGapsMaxPerCycle({ MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE: "0" })).toBe(200);
    await seedGaps(30);
    process.env.MEMRAIN_EMBED_GAPS_MAX_PER_CYCLE = "15";
    const r = await embedGapsPhase(storage.engine(), { embed });
    expect(r.embedded).toBe(15);
  });

  it("does nothing and pays nothing with MEMRAIN_EMBED_GAPS=0", async () => {
    await seedGaps(5);
    process.env.MEMRAIN_EMBED_GAPS = "0";
    let calls = 0;
    const r = await embedGapsPhase(storage.engine(), {
      embed: async () => {
        calls++;
        return embed();
      },
    });
    expect(r.ran).toBe(false);
    expect(calls).toBe(0);
    expect(await embeddedCount()).toBe(0);
  });

  it("stops the tick when every call in a step fails", async () => {
    await seedGaps(120);
    let calls = 0;
    const r = await embedGapsPhase(storage.engine(), {
      maxPerCycle: 120,
      embed: async () => {
        calls++;
        throw new Error("Service unavailable");
      },
    });
    expect(r.embedded).toBe(0);
    expect(r.failed).toBe(50);
    expect(calls).toBe(50);
  });

  it("runs in the default cycle, outside quiet hours only", () => {
    expect(ALL_PHASES.indexOf("embed-gaps")).toBe(ALL_PHASES.indexOf("embed-stale") + 1);
    const none = new Set<string>();
    expect(selectTickPhases({ inQuiet: false, synthEnabled: false, skipPhases: none })).toContain("embed-gaps");
    expect(selectTickPhases({ inQuiet: true, synthEnabled: false, skipPhases: none })).not.toContain("embed-gaps");
  });

  it("runs its paid calls under the phase spend tag", async () => {
    await seedGaps(2);
    const seen: (string | undefined)[] = [];
    const r = await runPhase(
      storage.engine(),
      "embed-gaps",
      () =>
        embedGapsPhase(storage.engine(), {
          embed: async () => {
            seen.push(currentSpendTags().phase);
            return embed();
          },
        }),
      NOOP_PROGRESS,
    );
    expect(r.status).toBe("ok");
    expect(seen).toEqual(["embed-gaps", "embed-gaps"]);
    expect(currentSpendTags().phase).toBeUndefined();
  });
});

describe("embed-backlog doctor check", () => {
  it("is ok with no backlog", async () => {
    expect((await checkEmbedBacklog(storage.engine())).status).toBe("ok");
  });

  it("stays ok while a large backlog is young", async () => {
    await seedGaps(1001, 1);
    const r = await checkEmbedBacklog(storage.engine());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("1001");
  });

  it("stays ok for an old backlog below the floor", async () => {
    await seedGaps(999, 48);
    expect((await checkEmbedBacklog(storage.engine())).status).toBe("ok");
  });

  it("warns on a backlog over the floor that is over a day old", async () => {
    await seedGaps(1001, 48);
    const r = await checkEmbedBacklog(storage.engine());
    expect(r.status).toBe("warn");
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("embed-gaps");
  });
});
