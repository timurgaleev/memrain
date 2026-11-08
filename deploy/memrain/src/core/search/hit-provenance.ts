export interface SearchProvenance {
  source_id: string | null;
  date: string | null;
  date_source: "effective" | "updated";
}

export function hitProvenance(row: {
  source_id?: string | null;
  effective_date?: string | null;
  updated_at?: string | null;
}): SearchProvenance {
  const value = row.effective_date ?? row.updated_at;
  const parsed = value ? new Date(value) : null;
  return {
    source_id: row.source_id ?? null,
    date: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null,
    date_source: row.effective_date ? "effective" : "updated",
  };
}
