import { useId } from "react";
import { fmtCost, overCap } from "./copy.ts";
import type { ModelsReport } from "./events.ts";

const perMillion = (usd: number) => `$${usd.toFixed(2)}`;

/** Only priced models are offered; the estimate and the cap are shown before anything is sent. */
export function ModelPicker({ report, value, onChange, disabled }: {
  report: ModelsReport;
  value: string | null;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const noteId = useId();
  const chosen = report.models.find((m) => m.id === value) ?? null;
  if (report.models.length === 0) return <span className="chat-estimate">Model: the server's default</span>;
  const cap = report.answer_cap_usd;
  const warn = chosen !== null && overCap(chosen.estimate_usd, cap);
  return (
    <div className="chat-model">
      <label htmlFor={id}>Model</label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={noteId}>
        {report.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · {perMillion(m.input_usd_per_m)} in / {perMillion(m.output_usd_per_m)} out per 1M tokens
          </option>
        ))}
      </select>
      <span id={noteId} className={warn ? "chat-estimate chat-estimate-warn" : "chat-estimate"}>
        {chosen?.estimate_usd == null
          ? cap !== null ? `Up to ${fmtCost(cap)} per answer` : ""
          : warn
            ? `This model's estimate, ${fmtCost(chosen.estimate_usd)}, is above the ${fmtCost(cap)} cap per answer.`
            : `About ${fmtCost(chosen.estimate_usd)} per answer${cap !== null ? `, capped at ${fmtCost(cap)}` : ""}`}
      </span>
    </div>
  );
}
