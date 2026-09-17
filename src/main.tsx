import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
// Side-effect only: must run before Monaco first spawns a worker - see the
// file itself for why (vite-plugin-monaco-editor vs. monaco-editor's newer
// COI-aware ESM worker loading).
import "./lib/monacoWorkerFix";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);