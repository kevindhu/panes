import { runWorkspaceScript } from "./lib/workspace-runtime.mjs";

const [scriptName, ...args] = process.argv.slice(2);

if (!scriptName) {
  throw new Error("Usage: node scripts/run-package-script.mjs <script-name> [...args]");
}

await runWorkspaceScript(scriptName, { args });
