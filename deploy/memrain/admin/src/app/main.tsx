import React from "react";
import ReactDOM from "react-dom/client";
import { MemberApp } from "./MemberApp.tsx";
import { takeInviteFromUrl } from "./route.ts";
import "../index.css";

// An invite link carries its token in the fragment (/app/invite#<token>). Move
// it into memory before anything renders or fetches, and replace the history
// entry so the token is never kept in the address bar, the back stack or a
// bookmark.
const invite = takeInviteFromUrl(window.location);
if (invite !== null) history.replaceState(null, "", "/app/#invite");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemberApp inviteToken={invite} />
  </React.StrictMode>,
);
