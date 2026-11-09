import React from "react";
import { createRoot } from "react-dom/client";
import { PageViewPage } from "../src/pages/PageView.tsx";
import { JobsWatchPage } from "../src/pages/JobsWatch.tsx";

const root = createRoot(document.getElementById("root")!);
root.render(new URLSearchParams(location.search).get("view") === "jobs"
  ? <JobsWatchPage />
  : <PageViewPage slug="notes/history" />);
Object.assign(window, { unmountFixture: () => root.unmount() });
