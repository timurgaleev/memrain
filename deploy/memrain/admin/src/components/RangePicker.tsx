import { RANGES } from "../lib/range.ts";
import type { RangeDays } from "../lib/range.ts";

export function RangePicker({ value, onChange }: { value: RangeDays; onChange: (d: RangeDays) => void }) {
  return (
    <div className="segmented range-picker" role="group" aria-label="Chart range">
      {RANGES.map((d) => (
        <button key={d} type="button" className={d === value ? "active" : ""} aria-pressed={d === value} onClick={() => onChange(d)}>
          {d}d
        </button>
      ))}
    </div>
  );
}
