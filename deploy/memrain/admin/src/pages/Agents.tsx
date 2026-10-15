import { useState } from "react";
import { CredentialsSection } from "./Credentials";

// Agents page: the unified credentials view (OAuth clients + legacy API keys)
// with per-credential usage, PAT mint/revoke, and client registration.

export function AgentsPage() {
  const [error, setError] = useState("");

  return (
    <>
      <h1 className="page-title">Agents</h1>
      {error && <div className="warning-bar">{error}</div>}
      <CredentialsSection setError={setError} />
    </>
  );
}
