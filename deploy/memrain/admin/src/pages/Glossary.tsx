import React, { useEffect } from "react";
import { GLOSSARY } from "../lib/glossary.ts";
import { buildHash } from "../lib/route.ts";
import { PageIntro } from "../components/PageIntro.tsx";

const termId = (id: string) => `term-${id}`;

export function GlossaryPage({ term }: { term: string | null }) {
  useEffect(() => {
    if (!term) return;
    const el = document.getElementById(termId(term));
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 96 });
  }, [term]);

  return (
    <>
      <h1 className="page-title">Glossary</h1>
      <PageIntro>The words this panel uses, in plain language.</PageIntro>
      <dl className="glossary">
        {GLOSSARY.map((g) => (
          <div key={g.id} id={termId(g.id)} className={`glossary-entry${g.id === term ? " glossary-hit" : ""}`}>
            <dt>{g.term}</dt>
            <dd>
              {g.text}
              {g.see && g.see.length > 0 && (
                <span className="glossary-see">
                  {" "}See also{" "}
                  {g.see.map((s, i) => {
                    const t = GLOSSARY.find((x) => x.id === s);
                    return t ? (
                      <React.Fragment key={s}>
                        {i > 0 && ", "}
                        <a href={buildHash({ name: "glossary", param: s })}>{t.term.toLowerCase()}</a>
                      </React.Fragment>
                    ) : null;
                  })}
                  .
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="hint glossary-foot">
        New here? The <a href="#setup">Setup guide</a> connects your first agent. Connection guides are in docs/clients in the repository.
      </p>
    </>
  );
}
