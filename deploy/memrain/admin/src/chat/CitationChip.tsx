import { buildHash } from "../lib/route.ts";
import type { Citation } from "./events.ts";

/** A numbered source; opens the page it points at. */
export function CitationChip({ citation }: { citation: Citation }) {
  return (
    <a
      className="chat-cite"
      href={buildHash({ name: "page", param: citation.slug, ...(citation.quote ? { quote: citation.quote } : {}) })}
      aria-label={`Source ${citation.n}: ${citation.title}`}
      title={citation.slug}
    >
      <span className="chat-cite-n" aria-hidden="true">{citation.n}</span>
      <span className="chat-cite-title" aria-hidden="true">{citation.title}</span>
    </a>
  );
}
