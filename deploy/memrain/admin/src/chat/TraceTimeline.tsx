import { buildHash } from "../lib/route.ts";
import { fmtDuration, traceLabel, traceSummary } from "./copy.ts";
import type { TraceEvent } from "./events.ts";

const MAX_SLUGS = 5;

/**
 * How the answer was found. Open while the answer is on its way, then folded
 * to one line; the steps are a polite live region so a screen reader hears
 * progress without being interrupted.
 */
export function TraceTimeline({ trace, live, costUsd }: { trace: TraceEvent[]; live: boolean; costUsd: number | null }) {
  if (!live && trace.length === 0) return null;
  return (
    <details className="chat-trace" open={live}>
      <summary>{live ? "Searching your memory…" : traceSummary(trace, costUsd)}</summary>
      <div aria-live="polite">
        <ol className="chat-steps" aria-label="Search steps">
          {trace.map((t, i) => (
            <li key={i} className={live && i === trace.length - 1 ? "chat-step chat-step-current" : "chat-step"}>
              <span className="chat-step-label">{traceLabel(t)}</span>
              {t.ms !== undefined && <span className="chat-step-ms num">{fmtDuration(t.ms)}</span>}
              {t.note && <span className="chat-step-note">{t.note}</span>}
              {t.slugs && t.slugs.length > 0 && (
                <span className="chat-step-slugs">
                  {t.slugs.slice(0, MAX_SLUGS).map((s) => (
                    <a key={s} className="mono" href={buildHash({ name: "page", param: s })}>{s}</a>
                  ))}
                  {t.slugs.length > MAX_SLUGS && <span className="muted">+{t.slugs.length - MAX_SLUGS} more</span>}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
