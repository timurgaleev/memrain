import { useState } from "react";
import { tool } from "../api.ts";
import { useAsync, useDebounced, useNow } from "../hooks.ts";
import { Section } from "../components/Tile.tsx";
import { fmtAgo } from "../lib/format.ts";
import { parsePageList } from "../lib/tool-result.ts";
import { buildHash } from "../lib/route.ts";

const SORTS = [
  { v: "updated_desc", label: "Recently updated" },
  { v: "updated_asc", label: "Least recently updated" },
  { v: "created_desc", label: "Recently created" },
  { v: "slug", label: "Slug A–Z" },
] as const;

const SINCE = [
  { v: "", label: "Any time" },
  { v: "1", label: "Last 24h" },
  { v: "7", label: "Last 7 days" },
  { v: "30", label: "Last 30 days" },
] as const;

export function PagesPage() {
  const now = useNow(30_000);
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number]["v"]>("updated_desc");
  const [since, setSince] = useState<(typeof SINCE)[number]["v"]>("");
  const dType = useDebounced(type.trim(), 300);
  const dTag = useDebounced(tag.trim(), 300);

  const list = useAsync(async (signal) => {
    const args: Record<string, unknown> = { sort, limit: 50 };
    if (dType) args.type = dType;
    if (dTag) args.tag = dTag;
    if (since) args.since = new Date(Date.now() - Number(since) * 86_400_000).toISOString();
    return parsePageList(await tool("page_list", args, signal));
  }, [dType, dTag, sort, since]);

  return (
    <>
      <h1 className="page-title">Pages</h1>
      <div className="filter-bar filter-wrap">
        <label className="field">
          <span>Type</span>
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="any" maxLength={64} />
        </label>
        <label className="field">
          <span>Tag</span>
          <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="any" maxLength={100} />
        </label>
        <label className="field">
          <span>Updated</span>
          <select value={since} onChange={(e) => setSince(e.target.value as typeof since)}>
            {SINCE.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            {SORTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <p className="hint">Looking for one slug? Press <kbd>⌘K</kbd>.</p>

      <Section state={list} isEmpty={(d) => d.length === 0} emptyText="No pages match these filters.">
        {(rows) => (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Page</th><th>Type</th><th>Updated</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.slug}>
                      <td>
                        <a href={buildHash({ name: "page", param: r.slug })} className="cell-link">
                          <span>{r.title || r.slug}</span>
                          {r.title && <span className="mono muted cell-sub">{r.slug}</span>}
                        </a>
                      </td>
                      <td className="mono">{r.type ?? "—"}</td>
                      <td className="muted" title={r.updated_at ?? undefined}>{fmtAgo(r.updated_at, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length >= 50 && <p className="hint">Showing the first 50. Narrow the filters to see others.</p>}
          </>
        )}
      </Section>
    </>
  );
}
