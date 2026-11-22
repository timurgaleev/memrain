import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PageViewPage } from "../src/pages/PageView.tsx";
import { JobsWatchPage } from "../src/pages/JobsWatch.tsx";
import { ConnectionsPage } from "../src/pages/Connections.tsx";
import { AutonomyPage } from "../src/pages/Autonomy.tsx";
import { ApprovalsPage } from "../src/pages/Approvals.tsx";
import { OfficePage } from "../src/pages/Office.tsx";
import { AskPage } from "../src/pages/Ask.tsx";
import { parseHash } from "../src/lib/route.ts";
import { CommandPalette } from "../src/components/CommandPalette.tsx";
import { ClientGrantEditor } from "../src/components/ClientGrant.tsx";

// Ask follows the hash like the real App does, so a thread link and a
// source link both land where they would in the panel.
function AskFixture() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (route.name === "page") return <PageViewPage slug={route.param} quote={route.quote ?? null} />;
  return <AskPage threadId={route.name === "ask" ? route.param : null} />;
}

function PaletteFixture() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <AskFixture />
      <CommandPalette open={open} onClose={() => setOpen(false)} />
    </>
  );
}

const VIEWS: Record<string, () => React.ReactElement> = {
  jobs: () => <JobsWatchPage />,
  connections: () => <ConnectionsPage />,
  autonomy: () => <AutonomyPage />,
  approvals: () => <ApprovalsPage />,
  office: () => <OfficePage />,
  ask: () => <AskFixture />,
  palette: () => <PaletteFixture />,
  grant: () => <ClientGrantEditor clientId="client-1" onClose={() => {}} onSaved={() => {}} />,
};

const root = createRoot(document.getElementById("root")!);
const view = VIEWS[new URLSearchParams(location.search).get("view") ?? ""];
root.render(view ? view() : <PageViewPage slug="notes/history" />);
Object.assign(window, { unmountFixture: () => root.unmount() });
