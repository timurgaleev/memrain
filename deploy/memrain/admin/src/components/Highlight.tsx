import React from "react";

function stripQuotes(t: string): string {
  let a = 0;
  let b = t.length;
  while (a < b && (t[a] === "\"" || t[a] === "'")) a += 1;
  while (b > a && (t[b - 1] === "\"" || t[b - 1] === "'")) b -= 1;
  return t.slice(a, b);
}

// Wraps case-insensitive matches of the query terms in <mark>. The snippet is
// split into strings and rendered as text children; nothing is parsed as HTML.
export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = Array.from(new Set(
    query.toLowerCase().split(/\s+/).map(stripQuotes).filter((t) => t.length >= 2),
  )).slice(0, 8);
  if (terms.length === 0 || text === "") return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    let hit = "";
    for (const t of terms) if (t.length > hit.length && lower.startsWith(t, i)) hit = t;
    if (hit) {
      if (plainStart < i) parts.push(text.slice(plainStart, i));
      parts.push(<mark key={i}>{text.slice(i, i + hit.length)}</mark>);
      i += hit.length;
      plainStart = i;
    } else {
      i += 1;
    }
  }
  if (plainStart < text.length) parts.push(text.slice(plainStart));
  return <>{parts}</>;
}
