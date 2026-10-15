const INT = new Intl.NumberFormat("en-US");
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function num(n: unknown): number | null {
  const v = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function fmtInt(n: unknown): string {
  const v = num(n);
  return v === null ? "—" : INT.format(v);
}

export function fmtUsd(n: unknown): string {
  const v = num(n);
  if (v === null) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return USD.format(v);
}

export function fmtAgo(iso: string | null, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function lastSegment(slug: string, max = 18): string {
  const parts = slug.split("/").filter((p) => p !== "");
  const seg = parts[parts.length - 1] ?? slug;
  return seg.length > max ? `${seg.slice(0, Math.max(1, max - 1))}…` : seg;
}
