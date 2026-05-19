import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, runWorkspaceScript } from "./lib/workspace-runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const requiredArtifacts = [
  path.join(repoRoot, "dist", "index.html"),
  path.join(
    repoRoot,
    "src-tauri",
    "sidecar-dist",
    "claude-agent-sdk-server.mjs",
  ),
];

async function ensureArtifactsExist() {
  for (const artifactPath of requiredArtifacts) {
    try {
      await access(artifactPath, fsConstants.F_OK);
    } catch {
      throw new Error(
        `Expected prebuilt desktop artifact was not found: ${path.relative(repoRoot, artifactPath)}`,
      );
    }
  }
}

if (process.env.PANES_SKIP_DESKTOP_PREBUILD === "1") {
  await ensureArtifactsExist();
  console.log("Using prebuilt desktop artifacts.");
  process.exit(0);
}

await runWorkspaceScript("build");
await runWorkspaceScript("build:claude-sidecar");
