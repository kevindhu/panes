import { runWorkspaceScript } from "./lib/workspace-runtime.mjs";

const [scriptName, ...args] = process.argv.slice(2);

if (!scriptName) {
  throw new Error("Usage: node scripts/run-package-script.mjs <script-name> [...args]");
}

const allowedExitCodes =
  process.platform === "win32" && scriptName === "dev"
    ? [-1]
    : [];

await runWorkspaceScript(scriptName, { args, allowedExitCodes });
