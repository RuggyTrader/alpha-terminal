import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./terminal/terminal.css";
import "./terminal/motion.css";
import "./terminal/verified.css";
import "./terminal/mirror.css";
import "./terminal/theme.css";
import "./terminal/home.css";
import { applyTheme, readThemePref, watchSystemTheme } from "./terminal/theme";

// The theme was already set before first paint by the inline script in index.html; this keeps it in sync
// with the stored choice and follows the device when the choice is "System".
applyTheme(readThemePref());
watchSystemTheme();

// No service worker is registered at start-up. /sw.js is registered only when the user enables notifications
// (Settings), and it has no fetch handler: every view shows fresh PAPER data from the backend, never a cached copy.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
