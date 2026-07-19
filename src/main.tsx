import React from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { App } from "./App";
import { AppErrorBoundary } from "./components/shared/AppErrorBoundary";
import { initializeI18n } from "./i18n";
import { startAppZoomSync } from "./lib/appZoom";
import "./globals.css";

async function bootstrap() {
  await initializeI18n();
  await startAppZoomSync();

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>
  );
}

void bootstrap();
