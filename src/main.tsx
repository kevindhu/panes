import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./components/shared/AppErrorBoundary";
import { initializeCodexI18n } from "./i18n/codex";
import { initializeCodexZoom } from "./lib/codexZoom";
import "./codex-base.css";
import "./codex.css";

async function bootstrap() {
  await initializeCodexI18n();
  await initializeCodexZoom();

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
}

void bootstrap();
