import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { parseEnrollToken, setPendingEnrollToken } from "./lib/passkey.ts";
import "./index.css";

// A setup link carries its token in the fragment. Move it into memory before
// anything renders or fetches, and replace the history entry so the token is
// never kept in the address bar, the back stack or a bookmark.
if (/^#\/?enroll\//.test(window.location.hash)) {
  setPendingEnrollToken(parseEnrollToken(window.location.hash));
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}#enroll`);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
