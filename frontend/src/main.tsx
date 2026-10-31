import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./terminal/terminal.css";

// No service worker is registered on purpose: every view must show fresh
// PAPER data from the backend, never a cached copy.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
