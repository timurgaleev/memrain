import { PageIntro } from "../components/PageIntro.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";

export function SetupPage() {
  return (
    <>
      <h1 className="page-title">Setup guide</h1>
      <PageIntro>How to connect an AI agent to this brain.</PageIntro>
      <SetupChecklist force />
    </>
  );
}
