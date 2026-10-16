export interface HBarRow { key: string; label: string; value: number; href?: string; note?: string; title?: string }

/** Ranked horizontal bars: a label, its value, and a bar scaled to the largest. */
export function HBarList({ rows, format, label }: { rows: HBarRow[]; format: (n: number) => string; label: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ol className="hbar" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className="hbar-item">
          <div className="hbar-line">
            {r.href ? (
              <a className="hbar-label" href={r.href} title={r.title ?? r.label}>{r.label}</a>
            ) : (
              <span className="hbar-label" title={r.title ?? r.label}>{r.label}</span>
            )}
            {r.note && <span className="hbar-note">{r.note}</span>}
            <span className="hbar-value mono">{format(r.value)}</span>
          </div>
          <span className="bar" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${max > 0 ? (r.value / max) * 100 : 0}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}
