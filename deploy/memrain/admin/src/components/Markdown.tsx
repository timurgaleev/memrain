import React, { useMemo } from "react";
import { parseMarkdown } from "../lib/markdown.ts";
import type { Block, Inline } from "../lib/markdown.ts";
import { buildHash } from "../lib/route.ts";

// Renders the typed tree from lib/markdown.ts. Every leaf is a React text
// child, so stored text can never become markup; hrefs come only from
// safeHref, and an image is named, never fetched.

function renderInline(nodes: Inline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (n.t) {
      case "text":
        return <React.Fragment key={key}>{n.v}</React.Fragment>;
      case "code":
        return <code key={key}>{n.v}</code>;
      case "strong":
        return <strong key={key}>{renderInline(n.c, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(n.c, key)}</em>;
      case "image":
        return <span key={key} className="md-image">[image: {n.alt || "untitled"}]</span>;
      case "wikilink":
        return <a key={key} href={buildHash({ name: "page", param: n.slug })} className="md-internal">{n.label}</a>;
      case "link":
        if (n.href === null) return <span key={key}>{renderInline(n.c, key)}</span>;
        if (n.href.kind === "internal") {
          return <a key={key} href={n.href.hash} className="md-internal">{renderInline(n.c, key)}</a>;
        }
        return (
          <a key={key} href={n.href.href} target="_blank" rel="noopener noreferrer nofollow" className="md-external">
            {renderInline(n.c, key)}
          </a>
        );
      default:
        return null;
    }
  });
}

function renderBlock(b: Block, key: string): React.ReactNode {
  switch (b.t) {
    case "heading": {
      const Tag = `h${b.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{renderInline(b.c, key)}</Tag>;
    }
    case "para":
      return <p key={key}>{renderInline(b.c, key)}</p>;
    case "code":
      return <pre key={key} className="md-code" data-lang={b.lang || undefined}><code>{b.v}</code></pre>;
    case "list": {
      const items = b.items.map((it, i) => <li key={`${key}.${i}`}>{renderInline(it, `${key}.${i}`)}</li>);
      return b.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "quote":
      return <blockquote key={key}>{b.c.map((c, i) => renderBlock(c, `${key}.${i}`))}</blockquote>;
    case "hr":
      return <hr key={key} />;
  }
}

export function Markdown({ source }: { source: string }) {
  const parsed = useMemo(() => parseMarkdown(source), [source]);
  if (parsed.blocks.length === 0) return <div className="empty-note">This page has no body.</div>;
  return (
    <div className="md">
      {parsed.blocks.map((b, i) => renderBlock(b, String(i)))}
      {parsed.truncated && <div className="notice">Body truncated for display. Use “Raw” for the full text.</div>}
    </div>
  );
}
