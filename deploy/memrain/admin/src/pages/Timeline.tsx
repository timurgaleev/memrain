import { tool } from "../api.ts";
import { useAsync } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { parseChronicle } from "../lib/tool-result.ts";
import type { ChronicleEvent } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

// #timeline           → the last 7 days
// #timeline/2026-10-01 → that day; "week" and "on this day" are view
// variants carried as a suffix (#timeline/2026-10-01~week).
type Mode = "since" | "day" | "week" | "otd";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseParam(param: string | null): { mode: Mode; date: string } {
  if (!param) return { mode: "since", date: todayUtc() };
  const [date = "", variant] = param.split("~");
  if (!DATE_RE.test(date)) return { mode: "since", date: todayUtc() };
  return { mode: variant === "week" ? "week" : variant === "otd" ? "otd" : "day", date };
}

function go(mode: Mode, date: string) {
  const param = mode === "since" ? null : mode === "day" ? date : `${date}~${mode}`;
  window.location.hash = buildHash({ name: "timeline", param });
}

export function TimelinePage({ param }: { param: string | null }) {
  const { mode, date } = parseParam(param);
  const events = useAsync(async (s) => {
    if (mode === "since") {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      return parseChronicle(await tool("chronicle_since", { since, limit: 100 }, s));
    }
    if (mode === "otd") return parseChronicle(await tool("chronicle_on_this_day", { date, limit: 100 }, s));
    return parseChronicle(await tool("chronicle_day", { date, limit: 100, ...(mode === "week" ? { week: true } : {}) }, s));
  }, [mode, date]);

  const heading = mode === "since" ? "Since 7 days ago"
    : mode === "week" ? `Week of ${date}` : mode === "otd" ? `On this day (${date.slice(5)}) in earlier years` : date;

  return (
    <>
      <h1 className="page-title">Timeline</h1>
      <div className="filter-bar filter-wrap">
        <div className="segmented" role="group" aria-label="View">
          {([["since", "Last 7 days"], ["day", "Day"], ["week", "Week"], ["otd", "On this day"]] as const).map(([m, label]) => (
            <button key={m} className={m === mode ? "active" : ""} aria-pressed={m === mode} onClick={() => go(m, date)}>{label}</button>
          ))}
        </div>
        <label className="field field-inline">
          <span>Date (UTC)</span>
          <input
            type="date"
            value={date}
            max={todayUtc()}
            onChange={(e) => { if (DATE_RE.test(e.target.value)) go(mode === "since" ? "day" : mode, e.target.value); }}
          />
        </label>
      </div>

      <h2 className="section-title">{heading}</h2>
      <section className="panel">
        <Section state={events} isEmpty={(d) => d.length === 0} emptyText="Nothing recorded for this period.">
          {(rows) => <EventList rows={rows} />}
        </Section>
      </section>
    </>
  );
}

function EventList({ rows }: { rows: ChronicleEvent[] }) {
  let lastDate: string | null = null;
  return (
    <ol className="timeline">
      {rows.map((e, i) => {
        const showDate = e.date !== lastDate;
        lastDate = e.date;
        return (
          <li key={`${e.date}:${i}`}>
            <time className="mono muted" dateTime={e.date ?? undefined}>{showDate ? e.date?.slice(0, 10) ?? "—" : ""}</time>
            <div>
              <div>
                {e.slug ? <a href={buildHash({ name: "page", param: e.slug })}>{e.summary || e.slug}</a> : e.summary}
                {e.kind && <span className="badge badge-read tl-kind">{e.kind}</span>}
              </div>
              {e.detail && <div className="muted small">{e.detail}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
