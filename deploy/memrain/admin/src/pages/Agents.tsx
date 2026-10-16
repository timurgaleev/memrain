import { useState } from "react";
import { CredentialsSection } from "./Credentials";
import { PageIntro } from "../components/PageIntro.tsx";

// Agents page: the unified credentials view (OAuth clients + legacy API keys)
// with per-credential usage, PAT mint/revoke, and client registration.

export function AgentsPage() {
  const [error, setError] = useState("");

  return (
    <>
      <h1 className="page-title">Agents</h1>
      <PageIntro>
        The apps and machines allowed to use this brain: personal access tokens and OAuth clients. A secret is shown once
        when you create it; only a hash is stored. Revoke a credential here to cut its access at once.
      </PageIntro>
      {error && <div className="warning-bar">{error}</div>}
      <CredentialsSection setError={setError} />
    </>
  );
}
