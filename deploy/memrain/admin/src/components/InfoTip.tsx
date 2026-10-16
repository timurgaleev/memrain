import { useEffect, useId, useRef, useState } from "react";
import { GLOSSARY, METRIC_HELP } from "../lib/glossary.ts";
import type { MetricId } from "../lib/glossary.ts";
import { buildHash } from "../lib/route.ts";
import { fitSpan } from "../lib/chart.ts";

const POP_WIDTH = 300;
const GUTTER = 16;

// A disclosure, not a tooltip: the "?" button toggles a short definition with
// a link into the glossary. Escape closes it and returns focus to the button;
// a click elsewhere closes it too. Built from spans so it can sit in a heading.
export function InfoTip({ id }: { id: MetricId }) {
  const help = METRIC_HELP[id];
  const term = GLOSSARY.find((g) => g.id === help.term);
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(-8);
  const popId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const toggle = () => {
    if (!open && wrap.current) {
      // Keep the whole popover on screen, so it never pushes the page wider.
      const left = wrap.current.getBoundingClientRect().left;
      const width = Math.min(POP_WIDTH, window.innerWidth - 2 * GUTTER);
      setShift(fitSpan(left - 8, width, GUTTER, window.innerWidth - GUTTER) - left);
    }
    setOpen((o) => !o);
  };

  return (
    <span
      className="info"
      ref={wrap}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
          btn.current?.focus();
        }
      }}
    >
      <button
        ref={btn}
        type="button"
        className="info-tip"
        aria-label={`About ${help.label}`}
        aria-expanded={open}
        aria-controls={popId}
        onClick={toggle}
      >
        ?
      </button>
      <span id={popId} className="info-pop" style={{ left: shift }} hidden={!open}>
        <span className="info-text">{help.text}</span>
        {term && (
          <a className="info-link" href={buildHash({ name: "glossary", param: term.id })} onClick={() => setOpen(false)}>
            See “{term.term}” in the glossary
          </a>
        )}
      </span>
    </span>
  );
}
