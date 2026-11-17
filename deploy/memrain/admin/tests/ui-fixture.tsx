import React from "react";
import { createRoot } from "react-dom/client";
import { PageViewPage } from "../src/pages/PageView.tsx";
import { JobsWatchPage } from "../src/pages/JobsWatch.tsx";
import { ConnectionsPage } from "../src/pages/Connections.tsx";
import { AutonomyPage } from "../src/pages/Autonomy.tsx";
import { ApprovalsPage } from "../src/pages/Approvals.tsx";
import { OfficePage } from "../src/pages/Office.tsx";

const VIEWS: Record<string, () => React.ReactElement> = {
  jobs: () => <JobsWatchPage />,
  connections: () => <ConnectionsPage />,
  autonomy: () => <AutonomyPage />,
  approvals: () => <ApprovalsPage />,
  office: () => <OfficePage />,
};

const root = createRoot(document.getElementById("root")!);
const view = VIEWS[new URLSearchParams(location.search).get("view") ?? ""];
root.render(view ? view() : <PageViewPage slug="notes/history" />);
Object.assign(window, { unmountFixture: () => root.unmount() });
