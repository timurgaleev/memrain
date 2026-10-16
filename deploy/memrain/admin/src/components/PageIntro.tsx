import React from "react";

/** One or two sentences under a page title saying what the page is for. */
export function PageIntro({ children }: { children: React.ReactNode }) {
  return <p className="page-intro">{children}</p>;
}
