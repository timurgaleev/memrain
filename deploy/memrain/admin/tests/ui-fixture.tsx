import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PageViewPage } from "../src/pages/PageView.tsx";
import { parseHash } from "../src/lib/route.ts";
import { CommandPalette } from "../src/components/CommandPalette.tsx";
import { ClientGrantEditor } from "../src/components/ClientGrant.tsx";

// The page view follows the hash like the real App does, so a page link with
// a quote lands where it would in the panel.
function PageFixture() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return <PageViewPage slug={route.name === "page" ? route.param : "notes/history"} quote={route.quote ?? null} />;
}

function PaletteFixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <PageFixture />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const VIEWS: Record<string, () => React.ReactElement> = {
  page: () => <PageFixture />,
  palette: () => <PaletteFixture />,
  grant: () => <ClientGrantEditor clientId="client-1" onClose={() => {}} onSaved={() => {}} />,
};

const root = createRoot(document.getElementById("root")!);
const view = VIEWS[new URLSearchParams(location.search).get("view") ?? ""];
root.render(view ? view() : <PageViewPage slug="notes/history" />);
Object.assign(window, { unmountFixture: () => root.unmount() });
